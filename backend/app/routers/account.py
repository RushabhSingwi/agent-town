"""Account → API tokens and model credentials. Browser session only (see require_session)."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .. import model_check, views
from ..auth import require_session
from ..config import settings
from ..db import get_db
from ..models import ApiToken, ModelCredential, User
from ..schemas import CredentialIn, CredentialPatch, TokenIn
from ..security import decrypt, encrypt, new_api_token

router = APIRouter(prefix="/api/account", tags=["account"])

LABELS = {("anthropic", "api_key"): "Anthropic API key", ("anthropic", "subscription"): "Claude subscription",
          ("openai", "api_key"): "OpenAI API key", ("openai", "subscription"): "ChatGPT subscription"}


# ---- API tokens ---------------------------------------------------------------------------

@router.get("/tokens")
def list_tokens(user: User = Depends(require_session), db: Session = Depends(get_db)):
    rows = db.scalars(select(ApiToken).where(ApiToken.user_id == user.id).order_by(ApiToken.created_at))
    return [views.api_token(t) for t in rows]


@router.post("/tokens")
def create_token(body: TokenIn, user: User = Depends(require_session), db: Session = Depends(get_db)):
    token, token_hash = new_api_token()
    expires = datetime.now(timezone.utc) + timedelta(days=body.expires_days) if body.expires_days else None
    t = ApiToken(user_id=user.id, name=body.name, token_hash=token_hash, prefix=token[:10], expires_at=expires)
    db.add(t)
    db.commit()
    # The only time the token itself is ever returned.
    return {**views.api_token(t), "token": token}


@router.delete("/tokens/{token_id}")
def revoke_token(token_id: int, user: User = Depends(require_session), db: Session = Depends(get_db)):
    t = db.get(ApiToken, token_id)
    if t is None or t.user_id != user.id:
        raise HTTPException(404, "No such token")
    db.delete(t)
    db.commit()
    return {"ok": True}


# ---- model credentials --------------------------------------------------------------------

def own_credential(db: Session, user: User, cred_id: int) -> ModelCredential:
    c = db.get(ModelCredential, cred_id)
    if c is None or c.owner_id != user.id:
        raise HTTPException(404, "No such credential")
    return c


@router.get("/credentials")
def list_credentials(user: User = Depends(require_session), db: Session = Depends(get_db)):
    rows = db.scalars(select(ModelCredential).where(ModelCredential.owner_id == user.id)
                      .order_by(ModelCredential.created_at))
    return {"allow_subscription_tokens": settings().allow_subscription_tokens,
            "credentials": [views.credential(c) for c in rows]}


@router.post("/credentials")
def add_credential(body: CredentialIn, user: User = Depends(require_session), db: Session = Depends(get_db)):
    if body.kind == "subscription" and not settings().allow_subscription_tokens:
        raise HTTPException(403, "Subscription tokens are off on this server: providers don't allow "
                                 "third-party services to use them. Use an API key, or self-host Agent Town "
                                 "for yourself with AGENTTOWN_ALLOW_SUBSCRIPTION_TOKENS=true.")
    problem = model_check.shape_error(body.provider, body.kind, body.secret)
    if problem:
        raise HTTPException(422, problem)
    secret = body.secret.strip()
    first = db.scalar(select(ModelCredential.id).where(ModelCredential.owner_id == user.id)) is None
    c = ModelCredential(owner_id=user.id, provider=body.provider, kind=body.kind,
                        label=body.label or LABELS[(body.provider, body.kind)],
                        secret_enc=encrypt(secret), hint=secret[-4:] if body.kind == "api_key" else "",
                        is_default=first)
    db.add(c)
    db.commit()
    _run_check(db, c, secret)
    return views.credential(c)


def _run_check(db: Session, c: ModelCredential, secret: str) -> None:
    r = model_check.check(c.provider, c.kind, secret)
    c.status, c.status_detail, c.last_checked_at = r.status, r.detail, datetime.now(timezone.utc)
    db.commit()


@router.post("/credentials/{cred_id}/check")
def check_credential(cred_id: int, user: User = Depends(require_session), db: Session = Depends(get_db)):
    c = own_credential(db, user, cred_id)
    secret = decrypt(c.secret_enc)
    if secret is None:
        c.status, c.status_detail = "error", "Can't decrypt: the server's secret key changed. Add it again."
        db.commit()
    else:
        _run_check(db, c, secret)
    return views.credential(c)


@router.patch("/credentials/{cred_id}")
def update_credential(cred_id: int, body: CredentialPatch, user: User = Depends(require_session),
                      db: Session = Depends(get_db)):
    c = own_credential(db, user, cred_id)
    if body.label is not None:
        c.label = body.label
    if body.is_default:
        db.execute(update(ModelCredential).where(ModelCredential.owner_id == user.id).values(is_default=False))
        c.is_default = True
    db.commit()
    return views.credential(c)


@router.delete("/credentials/{cred_id}")
def delete_credential(cred_id: int, user: User = Depends(require_session), db: Session = Depends(get_db)):
    c = own_credential(db, user, cred_id)
    was_default = c.is_default
    db.delete(c)
    db.commit()
    if was_default:  # hand the default to the oldest remaining one
        nxt = db.scalar(select(ModelCredential).where(ModelCredential.owner_id == user.id)
                        .order_by(ModelCredential.created_at))
        if nxt:
            nxt.is_default = True
            db.commit()
    return {"ok": True}
