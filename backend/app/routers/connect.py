"""Signing in to Google so agents can use Gmail and Calendar (see app/google.py).

  GET    /api/connect/google              is it set up here, and which Google accounts you've connected
  GET    /api/connect/google/start        → Google's consent screen
  GET    /api/connect/google/callback     ← Google sends the person back here with a code
  DELETE /api/connect/google/{id}         disconnect: revoke at Google and delete our copy

The `state` sent to Google is encrypted and expires in 10 minutes, and it's tied to this browser by
a one-time cookie. Without that, someone could send you a link that connects *your* Gmail to *their*
Agent Town account (OAuth's classic login-CSRF).
"""

import json
import secrets
from datetime import datetime, timezone
from urllib.parse import urlencode, urlparse

from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import google
from ..auth import current_user, require_user
from ..config import settings
from ..db import get_db
from ..models import Agent, AgentToolGrant, McpConnection, OAuthAccount, User
from ..security import _fernet
from .runs import end_open_runs

router = APIRouter(prefix="/api/connect/google", tags=["connect"])
NONCE = "agenttown_oauth"
TTL = 600


def account_view(a: OAuthAccount) -> dict:
    return {"id": a.id, "email": a.email, "status": a.status, "apps": google.apps_granted(a.scopes)}


@router.get("")
def status(user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(OAuthAccount).where(OAuthAccount.owner_id == user.id, OAuthAccount.provider == "google"))
    return {"configured": google.configured(), "app_url": settings().app_url.rstrip("/"),
            "accounts": [account_view(a) for a in rows]}


def _back(**params) -> RedirectResponse:
    return RedirectResponse(settings().app_url.rstrip("/") + "/?" + urlencode(params), status_code=303)


@router.get("/start")
def start(request: Request, apps: str = "gmail", agent: int | None = None, user: User | None = Depends(current_user)):
    """`agent`: connecting from that agent's "Make it your own", so give it access once connected."""
    if not google.configured():
        raise HTTPException(404, "Google isn't set up on this server")
    if user is None or getattr(request.state, "auth", None) != "session":
        raise HTTPException(401, "Sign in to Agent Town first")
    want = [a for a in apps.split(",") if a in google.SCOPES] or ["gmail"]
    if urlparse(str(request.base_url)).netloc != urlparse(settings().app_url).netloc:
        # Google only sends people back to the registered address; starting anywhere else loses the cookie.
        raise HTTPException(400, f"Open Agent Town at {settings().app_url} to connect Google")
    verifier, challenge = google.pkce()
    nonce = secrets.token_urlsafe(16)
    state = _fernet().encrypt(json.dumps({"u": user.id, "n": nonce, "v": verifier, "a": want, "g": agent}).encode()).decode()
    resp = RedirectResponse(google.authorize_url(state, challenge, want), status_code=303)
    resp.set_cookie(NONCE, nonce, max_age=TTL, httponly=True, samesite="lax", secure=settings().cookie_secure,
                    path="/api/connect/google")
    return resp


@router.get("/callback")
def callback(request: Request, state: str = "", code: str = "", error: str = "",
             user: User | None = Depends(current_user), db: Session = Depends(get_db)):
    try:
        s = json.loads(_fernet().decrypt(state.encode(), ttl=TTL))
    except (InvalidToken, ValueError):
        return _back(connect_error="That sign-in link expired. Try connecting again.")
    if not user or user.id != s["u"] or request.cookies.get(NONCE) != s["n"]:
        return _back(connect_error="That sign-in didn't start in this browser. Try connecting again.")
    if error or not code:
        return _back(connect_error="Google sign-in was cancelled." if error == "access_denied" else f"Google said: {error or 'no code'}")
    try:
        tok = google.exchange(code, s["v"])
        info = google.userinfo(tok["access_token"])
    except google.GoogleError as e:
        return _back(connect_error=str(e))

    acct = db.scalar(select(OAuthAccount).where(OAuthAccount.owner_id == user.id, OAuthAccount.provider == "google",
                                                OAuthAccount.subject == info["sub"]))
    if acct is None:
        acct = OAuthAccount(owner_id=user.id, provider="google", subject=info["sub"])
        db.add(acct)
    acct.email = info.get("email", "")
    google.store_tokens(acct, tok)
    db.flush()
    granted = google.apps_granted(acct.scopes)
    for app in granted:                             # one connection per app, with its fixed tools
        conn = db.scalar(select(McpConnection).where(McpConnection.oauth_account_id == acct.id, McpConnection.app == app))
        if conn is None:
            name = google.APP_NAMES[app]
            if db.scalar(select(McpConnection).where(McpConnection.owner_id == user.id, McpConnection.name == name)):
                name = f"{name} ({acct.email})"
            conn = McpConnection(owner_id=user.id, name=name[:60], transport="hosted", oauth_account_id=acct.id, app=app)
            db.add(conn)
        google.sync_tools(conn)
        conn.status, conn.status_detail = "connected", f"Signed in as {acct.email}"
        conn.server_name, conn.last_checked_at = "Agent Town (hosted)", datetime.now(timezone.utc)
    a = db.get(Agent, s.get("g")) if s.get("g") else None
    if a is not None and a.owner_id == user.id:
        db.flush()
        for conn in db.scalars(select(McpConnection).where(McpConnection.oauth_account_id == acct.id)):
            if not any(g.connection_id == conn.id for g in a.grants):
                a.grants.append(AgentToolGrant(connection_id=conn.id, tool_name=None))
        end_open_runs(db, a, "It can use new apps now: your next message starts a fresh chat with them.")
    db.commit()
    resp = _back(connected=",".join(granted) or "none")
    resp.delete_cookie(NONCE, path="/api/connect/google")
    return resp


@router.delete("/{account_id}")
def disconnect(account_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    acct = db.get(OAuthAccount, account_id)
    if acct is None or acct.owner_id != user.id:
        raise HTTPException(404, "No such account")
    google.revoke(acct)
    db.delete(acct)                                 # its connections (and agents' access) go with it
    db.commit()
    return {"ok": True}
