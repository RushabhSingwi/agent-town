from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import mcp_client, views
from ..auth import require_user
from ..config import settings
from ..db import get_db
from ..models import Agent, AgentToolGrant, McpConnection, McpTool, User
from ..schemas import McpIn, McpPatch
from ..security import decrypt, encrypt

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


def own_connection(db: Session, user: User, conn_id: int) -> McpConnection:
    c = db.get(McpConnection, conn_id)
    if c is None or c.owner_id != user.id:
        raise HTTPException(404, "No such connection")
    return c


def view(db: Session, c: McpConnection) -> dict:
    rows = db.execute(select(Agent.id, Agent.name, AgentToolGrant.tool_name)
                      .join(AgentToolGrant, AgentToolGrant.agent_id == Agent.id)
                      .where(AgentToolGrant.connection_id == c.id)).all()
    return views.connection(c, [{"agent_id": i, "agent": n, "tool_name": t} for i, n, t in rows])


def run_check(db: Session, c: McpConnection) -> None:
    """Handshake with the server and store what it says. stdio servers run in the sandbox,
    which doesn't exist yet, so they can't be checked from here."""
    c.last_checked_at = datetime.now(timezone.utc)
    if c.transport == "stdio":
        c.status, c.status_detail = "needs_sandbox", "stdio servers start inside the agent's sandbox"
        db.commit()
        return
    auth = decrypt(c.auth_header_enc) if c.auth_header_enc else None
    r = mcp_client.check(c.url or "", auth, allow_private=settings().allow_private_mcp_hosts)
    c.status, c.status_detail = r.status, r.detail[:2000]
    if r.status == "connected":
        c.server_name, c.server_version = r.server_name[:200], r.server_version[:80]
        by_name = {t.name: t for t in c.tools}
        seen = set()
        for t in r.tools:
            name = str(t.get("name", ""))[:200]
            if not name or name in seen:
                continue
            seen.add(name)
            row = by_name.get(name) or McpTool(name=name)
            row.description = str(t.get("description") or "")[:4000]
            row.input_schema = t.get("inputSchema") or {}
            if name not in by_name:
                c.tools.append(row)
        c.tools = [t for t in c.tools if t.name in seen]
        # a tool that disappeared can't stay granted
        for g in db.scalars(select(AgentToolGrant).where(AgentToolGrant.connection_id == c.id)):
            if g.tool_name is not None and g.tool_name not in seen:
                db.delete(g)
    db.commit()


def _validate(transport: str, url: str | None, command: str | None) -> None:
    if transport == "http" and not url:
        raise HTTPException(422, "An http connection needs a url")
    if transport == "stdio" and not command:
        raise HTTPException(422, "A stdio connection needs a command")


@router.get("")
def my_connections(user: User = Depends(require_user), db: Session = Depends(get_db)):
    conns = db.scalars(select(McpConnection).where(McpConnection.owner_id == user.id)
                       .order_by(McpConnection.created_at)).all()
    return [view(db, c) for c in conns]


@router.post("")
def add_connection(body: McpIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    _validate(body.transport, body.url, body.command)
    if db.scalar(select(McpConnection).where(McpConnection.owner_id == user.id, McpConnection.name == body.name)):
        raise HTTPException(409, "You already have a connection with that name")
    c = McpConnection(owner_id=user.id, name=body.name, transport=body.transport,
                      url=body.url if body.transport == "http" else None,
                      command=body.command if body.transport == "stdio" else None,
                      auth_header_enc=encrypt(body.auth_header) if body.auth_header else None)
    db.add(c)
    db.commit()
    run_check(db, c)
    return view(db, c)


@router.patch("/{conn_id}")
def update_connection(conn_id: int, body: McpPatch, user: User = Depends(require_user), db: Session = Depends(get_db)):
    c = own_connection(db, user, conn_id)
    if body.name is not None:
        c.name = body.name
    if body.url is not None and c.transport == "http":
        c.url = body.url
    if body.command is not None and c.transport == "stdio":
        c.command = body.command
    if body.auth_header is not None:
        c.auth_header_enc = encrypt(body.auth_header) if body.auth_header else None
    _validate(c.transport, c.url, c.command)
    db.commit()
    run_check(db, c)
    return view(db, c)


@router.post("/{conn_id}/check")
def check_connection(conn_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    c = own_connection(db, user, conn_id)
    run_check(db, c)
    return view(db, c)


@router.delete("/{conn_id}")
def delete_connection(conn_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    db.delete(own_connection(db, user, conn_id))
    db.commit()
    return {"ok": True}
