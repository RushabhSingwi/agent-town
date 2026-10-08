import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import views
from ..auth import current_user, require_user
from ..db import get_db
from ..manifest import build_manifest
from ..models import DEFINITION, Agent, AgentFile, AgentToolGrant, McpConnection, ModelCredential, PublicShare, User
from ..schemas import AgentIn, AgentPatch, FileIn, GrantsIn

router = APIRouter(prefix="/api/agents", tags=["agents"])

PALETTE = ["#8a6fd1", "#d1694f", "#3f8fd2", "#4fae6a", "#d6a23a", "#c8579b", "#3aa6a6", "#7f8a99"]


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30]
    return s if len(s) >= 3 else (s + "-agent")[:30]


def own_agent(db: Session, user: User, agent_id: int) -> Agent:
    a = db.get(Agent, agent_id)
    if a is None or a.owner_id != user.id:  # someone else's agent looks exactly like a missing one
        raise HTTPException(404, "No such agent")
    return a


def owner_view(db: Session, a: Agent) -> dict:
    share = db.scalar(select(PublicShare).where(PublicShare.kind == "agent", PublicShare.agent_id == a.id))
    file_shares = dict(db.execute(select(PublicShare.file_id, PublicShare.id).where(
        PublicShare.kind == "file", PublicShare.file_id.in_([f.id for f in a.files]))).all())
    return views.agent_owner_view(a, share, file_shares)


def _set_file(a: Agent, path: str, content: str) -> AgentFile:
    f = next((x for x in a.files if x.path == path), None)
    if f is None:
        f = AgentFile(path=path)
        a.files.append(f)
    f.set_content(content)
    if path == DEFINITION:
        meta, _ = views.frontmatter(content)
        if meta.get("description"):
            a.description = meta["description"][:2000]
    return f


@router.get("")
def my_agents(user: User = Depends(require_user), db: Session = Depends(get_db)):
    agents = db.scalars(select(Agent).where(Agent.owner_id == user.id).order_by(Agent.created_at)).all()
    return [owner_view(db, a) for a in agents]


@router.post("")
def create_agent(body: AgentIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    meta, _ = views.frontmatter(body.markdown)
    name = (body.name or meta.get("name") or "").strip()
    if not name:
        raise HTTPException(422, "Give the agent a name (or a `name:` line in its frontmatter)")
    slug, n = _slugify(name), 2
    while db.scalar(select(Agent).where(Agent.owner_id == user.id, Agent.slug == slug)):
        slug, n = f"{_slugify(name)[:27]}-{n}", n + 1
    color = body.color or meta.get("color", "")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        color = PALETTE[len(user.agents) % len(PALETTE)]
    a = Agent(owner_id=user.id, name=name[:80], slug=slug, description=meta.get("description", "")[:2000],
              color=color)
    db.add(a)
    _set_file(a, DEFINITION, body.markdown)
    for f in body.files:
        if f.path != DEFINITION:
            _set_file(a, f.path, f.content)
    db.commit()
    return owner_view(db, a)


@router.get("/{agent_id}")
def get_agent(agent_id: int, user: User | None = Depends(current_user), db: Session = Depends(get_db)):
    a = db.get(Agent, agent_id)
    if a and user and a.owner_id == user.id:
        return owner_view(db, a)
    shared = a and db.scalar(select(PublicShare).where(PublicShare.kind == "agent", PublicShare.agent_id == a.id))
    if not shared:
        raise HTTPException(404, "No such agent")
    return views.share(shared, with_content=True)["agent"]


@router.patch("/{agent_id}")
def update_agent(agent_id: int, body: AgentPatch, user: User = Depends(require_user), db: Session = Depends(get_db)):
    a = own_agent(db, user, agent_id)
    changes = body.model_dump(exclude_none=True)
    cred_id = changes.pop("model_credential_id", None)
    if cred_id is not None:
        if cred_id == 0:
            a.model_credential_id = None
        else:
            c = db.get(ModelCredential, cred_id)
            if c is None or c.owner_id != user.id:
                raise HTTPException(404, "No such credential")
            a.model_credential_id = c.id
    for field, value in changes.items():
        setattr(a, field, value)
    db.commit()
    return owner_view(db, a)


@router.delete("/{agent_id}")
def delete_agent(agent_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    db.delete(own_agent(db, user, agent_id))
    db.commit()
    return {"ok": True}


@router.put("/{agent_id}/files")
def put_file(agent_id: int, body: FileIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if ".." in body.path.split("/"):
        raise HTTPException(422, "No .. in paths")
    a = own_agent(db, user, agent_id)
    _set_file(a, body.path, body.content)
    db.commit()
    return owner_view(db, a)


@router.delete("/{agent_id}/files/{file_id}")
def delete_file(agent_id: int, file_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    a = own_agent(db, user, agent_id)
    f = next((x for x in a.files if x.id == file_id), None)
    if f is None:
        raise HTTPException(404, "No such file")
    if f.path == DEFINITION:
        raise HTTPException(422, "AGENT.md is the agent itself; delete the agent instead")
    a.files.remove(f)
    db.commit()
    return owner_view(db, a)


@router.put("/{agent_id}/grants")
def set_grants(agent_id: int, body: GrantsIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Replace which tools this agent may use. Only your own connections can be granted."""
    a = own_agent(db, user, agent_id)
    wanted = set()
    for g in body.grants:
        conn = db.get(McpConnection, g.connection_id)
        if conn is None or conn.owner_id != user.id:
            raise HTTPException(404, f"No such connection: {g.connection_id}")
        if g.tool_name is not None and g.tool_name not in {t.name for t in conn.tools}:
            raise HTTPException(422, f"{conn.name} has no tool {g.tool_name!r}")
        wanted.add((g.connection_id, g.tool_name))
    a.grants = [x for x in a.grants if (x.connection_id, x.tool_name) in wanted]
    have = {(x.connection_id, x.tool_name) for x in a.grants}
    a.grants += [AgentToolGrant(connection_id=c, tool_name=t) for c, t in sorted(wanted - have, key=str)]
    db.commit()
    return owner_view(db, a)


@router.get("/{agent_id}/manifest")
def manifest(agent_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Everything this agent gets when it runs: what its sandbox is handed."""
    return build_manifest(db, own_agent(db, user, agent_id))
