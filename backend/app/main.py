"""Agent Town API.  Run:  uv run uvicorn app.main:app --reload   (docs at /docs)"""

import logging
import os
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import views
from .auth import current_user
from .config import DEV_SECRET, settings
from .db import get_db
from .models import Agent, McpConnection, PublicShare, User
from .routers import agents, auth, mcp, public
from .routers.agents import owner_view
from .routers.mcp import view as connection_view

log = logging.getLogger("agenttown")
if settings().secret_key == DEV_SECRET:
    log.warning("AGENTTOWN_SECRET_KEY is the dev default; set a real one before storing real credentials")

app = FastAPI(title="Agent Town", version="0.1.0")


@app.middleware("http")
async def same_origin_writes(request: Request, call_next):
    """CSRF guard. The session cookie is SameSite=Lax, so other sites can't send it on a POST.
    Belt and braces: a write whose Origin is another site is refused outright."""
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        host = request.headers.get("x-forwarded-host") or request.headers.get("host")
        if origin and urlparse(origin).netloc != host:
            return JSONResponse({"detail": "Cross-site request refused"}, status_code=403)
    return await call_next(request)


for r in (auth.router, agents.router, mcp.router, public.router):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/city", tags=["city"])
def city(user: User | None = Depends(current_user), db: Session = Depends(get_db)):
    """Everything the map draws in one request: the public district for everyone,
    plus your private district and your tools when signed in."""
    shares = db.scalars(select(PublicShare).order_by(PublicShare.created_at)).all()
    out = {"me": views.user(user) if user else None, "public": [views.share(s) for s in shares],
           "agents": [], "connections": []}
    if user:
        mine = db.scalars(select(Agent).where(Agent.owner_id == user.id).order_by(Agent.created_at)).all()
        conns = db.scalars(select(McpConnection).where(McpConnection.owner_id == user.id)
                           .order_by(McpConnection.created_at)).all()
        out["agents"] = [owner_view(db, a) for a in mine]
        out["connections"] = [connection_view(db, c) for c in conns]
    return out


# In production the built frontend (frontend/dist) is served from here, so it's one process.
DIST = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
if os.path.isdir(DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST, "assets")), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        candidate = os.path.join(DIST, path)
        if path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(DIST, "index.html"))
