"""Running an agent: a sandbox per chat, with the owner's own model credential.

Two audiences, two kinds of credential:
  /api/agents/{id}/runs, /api/runs/…   the owner (session cookie or API token)
  /api/runtime/…                       the sandbox (its run token, "Bearer rt_…")

The sandbox never accepts connections: it calls us. It fetches its setup once, then polls its
inbox for the owner's messages and posts back what the agent says and does. So it needs no
public address, and the same code works on any provider.
"""

import json
import time
from datetime import datetime, timedelta, timezone

import httpx

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .. import sandbox
from ..auth import require_user
from ..config import settings
from ..db import get_db
from ..manifest import build_manifest
from ..models import McpConnection, ModelCredential, Run, RunEvent, User
from ..security import RUN_TOKEN_PREFIX, decrypt, hash_token, new_run_token
from .agents import own_agent

router = APIRouter(tags=["runs"])

ACTIVE = ("starting", "ready", "busy")
BOOT_GRACE = timedelta(minutes=10)   # the first Modal run builds the image
SILENCE = timedelta(minutes=2)       # a running sandbox polls every second; this long quiet = gone
EXIT_CHECK = timedelta(seconds=15)   # a box still "starting" after this: ask the provider if it died
_checked: dict[int, float] = {}      # run id -> when we last asked (don't ask on every UI poll)
_reachable_until = 0.0
FROM_SANDBOX = {"text", "tool", "tool_result", "done", "status", "error"}
MAX_EVENT = 100_000


def _utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)  # SQLite drops the timezone


def _iso(dt):
    return _utc(dt).isoformat() if dt else None


def run_view(r: Run) -> dict:
    return {"id": r.id, "agent_id": r.agent_id, "status": r.status, "detail": r.detail, "provider": r.provider,
            "created_at": _iso(r.created_at), "last_active_at": _iso(r.last_active_at), "ended_at": _iso(r.ended_at)}


def event_view(e: RunEvent) -> dict:
    return {"id": e.id, "kind": e.kind, "data": e.data, "created_at": _iso(e.created_at)}


def _end(db: Session, r: Run, status: str, detail: str) -> None:
    """Stop for good: the token stops working at once, then the box is torn down (best effort)."""
    if r.ended_at is not None:
        return
    r.status, r.detail, r.ended_at = status, detail[:2000], datetime.now(timezone.utc)
    db.add(RunEvent(run_id=r.id, kind="status", data={"status": status, "detail": detail[:2000]}))
    db.commit()
    if r.sandbox_id:
        try:
            sandbox.provider(r.provider).stop(r.sandbox_id)
        except Exception:  # noqa: BLE001  (already ended for us; the provider's own timeout is the backstop)
            pass


def _reap(db: Session, r: Run) -> None:
    """Runs end on their own (idle timeout in the runner), but a crashed box can't say so."""
    if r.ended_at is not None:
        return
    now = datetime.now(timezone.utc)
    if now - _utc(r.created_at) > timedelta(hours=settings().run_max_hours):
        _end(db, r, "stopped", "Reached the maximum run length")
    elif r.status == "starting" and now - _utc(r.created_at) > BOOT_GRACE:
        _end(db, r, "error", "The sandbox never started")
    elif r.status == "starting" and r.sandbox_id and now - _utc(r.created_at) > EXIT_CHECK \
            and time.monotonic() - _checked.get(r.id, 0) > 10:
        _checked[r.id] = time.monotonic()
        try:
            gone = not sandbox.provider(r.provider).alive(r.sandbox_id)
        except Exception:  # noqa: BLE001  (can't tell: leave it to BOOT_GRACE)
            gone = False
        if gone:  # it exited before it ever checked in: almost always it couldn't reach us
            _end(db, r, "error", f"The sandbox stopped before it could reach Agent Town at {settings().public_url}")
    elif r.status != "starting" and now - _utc(r.last_seen_at) > SILENCE:
        _end(db, r, "error", "The sandbox stopped responding")


def own_run(db: Session, user: User, run_id: int) -> Run:
    r = db.get(Run, run_id)
    if r is None or r.owner_id != user.id:
        raise HTTPException(404, "No such run")
    _reap(db, r)
    return r


def reachable_problem() -> str | None:
    """A sandbox calls us back at public_url. If that doesn't answer (a stopped tunnel, a wrong
    URL), say so now instead of letting the person watch "starting" for minutes."""
    global _reachable_until
    if settings().sandbox_provider == "local" or time.monotonic() < _reachable_until:
        return None
    url = settings().public_url.rstrip("/") + "/api/health"
    try:
        ok = httpx.get(url, timeout=5, headers={"User-Agent": "agent-town-selfcheck"}).json().get("ok") is True
    except (httpx.HTTPError, ValueError, AttributeError):
        ok = False
    if not ok:
        return (f"Sandboxes reach Agent Town at {settings().public_url}, but nothing answers there. "
                "If that's a tunnel (ngrok), restart it and update AGENTTOWN_PUBLIC_URL.")
    _reachable_until = time.monotonic() + 60
    return None


def _launch(make_session: sessionmaker, run_id: int, token: str) -> None:
    """After the response is sent: ask the provider for a box. Slow on a cold start, which is
    why POST /runs answers 202 right away and the UI watches the status instead."""
    db = make_session()
    try:
        r = db.get(Run, run_id)
        try:
            sid = sandbox.provider(r.provider).start(run_id, token)
        except Exception as e:  # noqa: BLE001
            _end(db, r, "error", f"Couldn't start the sandbox: {type(e).__name__}: {e}")
            return
        db.refresh(r)
        r.sandbox_id = sid
        db.commit()
        if r.ended_at is not None:  # stopped while it was booting
            sandbox.provider(r.provider).stop(sid)
    finally:
        db.close()


# ---- the owner ------------------------------------------------------------------------------

@router.post("/api/agents/{agent_id}/runs", status_code=202)
def start_run(agent_id: int, bg: BackgroundTasks, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Open a chat with this agent. If one is already running it's reused (no cold start)."""
    a = own_agent(db, user, agent_id)
    for r in db.scalars(select(Run).where(Run.agent_id == a.id, Run.ended_at.is_(None))):
        _reap(db, r)
        if r.ended_at is None:
            return run_view(r)
    m = build_manifest(db, a)
    if m["model"] is None:
        raise HTTPException(422, "Add a model key or subscription first (your @username → Models)")
    problem = reachable_problem()
    if problem:
        raise HTTPException(503, problem)
    token, token_hash = new_run_token()
    r = Run(agent_id=a.id, owner_id=user.id, credential_id=m["model"]["credential_id"],
            provider=settings().sandbox_provider, token_hash=token_hash)
    db.add(r)
    db.commit()
    bg.add_task(_launch, sessionmaker(bind=db.get_bind(), expire_on_commit=False), r.id, token)
    return run_view(r)


@router.get("/api/agents/{agent_id}/runs/active")
def active_run(agent_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """The agent's running chat, if there is one (null if not). Never starts a sandbox, so the UI
    can call it whenever someone just looks at an agent."""
    a = own_agent(db, user, agent_id)
    for r in db.scalars(select(Run).where(Run.agent_id == a.id, Run.ended_at.is_(None))):
        _reap(db, r)
        if r.ended_at is None:
            return run_view(r)
    return None


@router.get("/api/runs/{run_id}")
def get_run(run_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    return run_view(own_run(db, user, run_id))


@router.get("/api/runs/{run_id}/events")
def run_events(run_id: int, after: int = 0, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """The conversation so far, or what's new since event `after`. The UI polls this."""
    r = own_run(db, user, run_id)
    rows = db.scalars(select(RunEvent).where(RunEvent.run_id == r.id, RunEvent.id > after)
                      .order_by(RunEvent.id).limit(500))
    return {"run": run_view(r), "events": [event_view(e) for e in rows]}


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=50_000)


@router.post("/api/runs/{run_id}/messages")
def send_message(run_id: int, body: MessageIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    r = own_run(db, user, run_id)
    if r.ended_at is not None:
        raise HTTPException(409, "This run has ended; start a new one")
    e = RunEvent(run_id=r.id, kind="user", data={"text": body.text})
    r.last_active_at = datetime.now(timezone.utc)
    db.add(e)
    db.commit()
    return event_view(e)


@router.delete("/api/runs/{run_id}")
def stop_run(run_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    r = own_run(db, user, run_id)
    _end(db, r, "stopped", "Stopped by you")
    return run_view(r)


# ---- the sandbox ----------------------------------------------------------------------------

def current_run(request: Request, db: Session = Depends(get_db)) -> Run:
    scheme, _, token = (request.headers.get("authorization") or "").partition(" ")
    if scheme.lower() != "bearer" or not token.startswith(RUN_TOKEN_PREFIX):
        raise HTTPException(401, "Use: Authorization: Bearer rt_…")
    r = db.scalar(select(Run).where(Run.token_hash == hash_token(token.strip())))
    if r is None or r.ended_at is not None:
        raise HTTPException(401, "Invalid run token, or the run has ended")
    return r


@router.get("/api/runtime/setup", tags=["runtime"])
def runtime_setup(r: Run = Depends(current_run), db: Session = Depends(get_db)):
    """The one place secrets leave the server: to this run's own sandbox, for the owner's own
    agent. The manifest stays secret-free; credentials come alongside it."""
    cred = db.get(ModelCredential, r.credential_id) if r.credential_id else None
    secret = decrypt(cred.secret_enc) if cred else None
    if cred is None or secret is None:
        _end(db, r, "error", "The model credential is gone or can't be decrypted; add it again")
        raise HTTPException(409, "No usable model credential")
    m = build_manifest(db, r.agent)
    headers = {}
    for t in m["tools"]:
        c = db.get(McpConnection, t["connection_id"])
        if c and c.auth_header_enc:
            headers[str(c.id)] = decrypt(c.auth_header_enc)
    return {"run_id": r.id, "manifest": m, "auth_headers": headers,
            "credential": {"provider": cred.provider, "kind": cred.kind, "secret": secret,
                           "model": m["model"]["model"]}}


@router.get("/api/runtime/inbox", tags=["runtime"])
def runtime_inbox(after: int = 0, r: Run = Depends(current_run), db: Session = Depends(get_db)):
    """The owner's messages since `after`. Polling this is also the sandbox's heartbeat."""
    now = datetime.now(timezone.utc)
    if now - _utc(r.last_seen_at) > timedelta(seconds=15):  # don't write on every poll
        r.last_seen_at = now
        db.commit()
    rows = db.scalars(select(RunEvent).where(RunEvent.run_id == r.id, RunEvent.kind == "user", RunEvent.id > after)
                      .order_by(RunEvent.id))
    return {"messages": [{"id": e.id, "text": e.data.get("text", "")} for e in rows],
            "idle_seconds": int((now - _utc(r.last_active_at)).total_seconds())}


class EventIn(BaseModel):
    kind: str
    data: dict = Field(default_factory=dict)


class EventsIn(BaseModel):
    events: list[EventIn] = Field(max_length=100)


@router.post("/api/runtime/events", tags=["runtime"])
def runtime_events(body: EventsIn, r: Run = Depends(current_run), db: Session = Depends(get_db)):
    r.last_seen_at = datetime.now(timezone.utc)
    for ev in body.events:
        if ev.kind not in FROM_SANDBOX:
            raise HTTPException(422, f"Unknown event kind {ev.kind!r}")
        if len(json.dumps(ev.data)) > MAX_EVENT:
            ev.data = {"truncated": True, **{k: v for k, v in ev.data.items() if k in ("name", "ok")}}
        if ev.kind == "status":
            status = ev.data.get("status")
            if status in ("stopped", "error"):
                _end(db, r, status, str(ev.data.get("detail", "")))
                return {"ok": True}
            if status in ("ready", "busy"):
                r.status = status
        if ev.kind == "done" and r.credential_id:
            cred = db.get(ModelCredential, r.credential_id)
            if cred and ev.data.get("ok") and cred.status == "unverified":  # a subscription token proved itself
                cred.status, cred.status_detail = "valid", "Worked in a run"
            elif cred and ev.data.get("auth_failed"):
                cred.status, cred.status_detail = "invalid", "Rejected by the provider during a run; add it again"
        db.add(RunEvent(run_id=r.id, kind=ev.kind, data=ev.data))
    db.commit()
    return {"ok": True}
