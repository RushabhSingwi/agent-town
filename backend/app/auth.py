"""Who is making this request? Session cookie -> user."""

from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuthSession, User
from .security import hash_token, new_session_token

COOKIE = "agenttown_session"


def start_session(db: Session, user: User, response: Response) -> None:
    token, token_hash = new_session_token()
    expires = datetime.now(timezone.utc) + timedelta(days=settings().session_days)
    db.add(AuthSession(user_id=user.id, token_hash=token_hash, expires_at=expires))
    db.commit()
    response.set_cookie(
        COOKIE, token, max_age=settings().session_days * 86400, httponly=True,
        samesite="lax", secure=settings().cookie_secure, path="/")


def end_session(db: Session, request: Request, response: Response) -> None:
    token = request.cookies.get(COOKIE)
    if token:
        found = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
        if found:
            db.delete(found)
            db.commit()
    response.delete_cookie(COOKIE, path="/")


def current_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    s = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    if s is None:
        return None
    expires = s.expires_at if s.expires_at.tzinfo else s.expires_at.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        db.delete(s)
        db.commit()
        return None
    return s.user


def require_user(user: User | None = Depends(current_user)) -> User:
    if user is None:
        raise HTTPException(401, "Sign in first")
    return user
