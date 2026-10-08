from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import views
from ..auth import current_user, end_session, start_session
from ..db import get_db
from ..models import User
from ..schemas import LoginIn, SignupIn
from ..security import hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Verifying against a real hash when the user doesn't exist keeps "no such user" and
# "wrong password" equally slow, so response time doesn't reveal which emails have accounts.
_DUMMY_HASH = hash_password("not-a-real-password")


@router.post("/signup")
def signup(body: SignupIn, response: Response, db: Session = Depends(get_db)):
    email = body.email.lower()
    taken = db.scalar(select(User).where(or_(func.lower(User.email) == email, User.username == body.username)))
    if taken:
        raise HTTPException(409, "That email or username is taken")
    u = User(email=email, username=body.username, password_hash=hash_password(body.password))
    db.add(u)
    db.commit()
    start_session(db, u, response)
    return views.user(u)


@router.post("/login")
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    key = body.login.strip().lower()
    u = db.scalar(select(User).where(or_(func.lower(User.email) == key, User.username == key)))
    if not verify_password(u.password_hash if u else _DUMMY_HASH, body.password) or u is None:
        raise HTTPException(401, "Wrong email/username or password")
    start_session(db, u, response)
    return views.user(u)


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    end_session(db, request, response)
    return {"ok": True}


@router.get("/me")
def me(u: User | None = Depends(current_user)):
    return views.user(u) if u else None
