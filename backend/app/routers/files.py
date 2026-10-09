"""Shared files (knowledge all your agents can read) and importing a folder of agents."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import importer, marketplace
from ..auth import require_user
from ..db import get_db
from ..models import DEFINITION, Agent, SharedFile, User
from ..schemas import MAX_FILE, FileIn
from .agents import new_agent, owner_view, set_file

router = APIRouter(tags=["files"])

MAX_IMPORT = 20_000_000  # bytes of text in one import


def shared_view(f: SharedFile, with_content: bool = False) -> dict:
    out = {"id": f.id, "path": f.path, "lines": f.lines, "bytes": f.bytes, "updated_at": f.updated_at.isoformat()}
    return {**out, "content": f.content} if with_content else out


def put_shared(db: Session, user: User, path: str, content: str) -> SharedFile:
    f = db.scalar(select(SharedFile).where(SharedFile.owner_id == user.id, SharedFile.path == path))
    if f is None:
        f = SharedFile(owner_id=user.id, path=path)
        db.add(f)
    f.set_content(content)
    return f


# ---- shared files ---------------------------------------------------------------------------

@router.get("/api/files")
def list_shared(user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(SharedFile).where(SharedFile.owner_id == user.id).order_by(SharedFile.path))
    return [shared_view(f) for f in rows]


@router.get("/api/files/{file_id}")
def get_shared(file_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    f = db.get(SharedFile, file_id)
    if f is None or f.owner_id != user.id:
        raise HTTPException(404, "No such file")
    return shared_view(f, with_content=True)


@router.put("/api/files")
def put_shared_file(body: FileIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if ".." in body.path.split("/"):
        raise HTTPException(422, "No .. in paths")
    f = put_shared(db, user, body.path, body.content)
    db.commit()
    return shared_view(f, with_content=True)


@router.delete("/api/files/{file_id}")
def delete_shared(file_id: int, user: User = Depends(require_user), db: Session = Depends(get_db)):
    f = db.get(SharedFile, file_id)
    if f is None or f.owner_id != user.id:
        raise HTTPException(404, "No such file")
    db.delete(f)
    db.commit()
    return {"ok": True}


# ---- import ---------------------------------------------------------------------------------

class UploadFile(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(max_length=MAX_FILE)


class PreviewIn(BaseModel):
    files: list[UploadFile] = Field(min_length=1, max_length=2000)
    main: str | None = Field(default=None, description="no agent definitions found: the file that is the agent")
    choices: dict[str, str] | None = Field(default=None, description="agent name -> source, when it has a command too")


class PlannedAgent(BaseModel):
    source: str
    name: str = Field(min_length=1, max_length=80)
    files: list[str] = Field(default_factory=list, max_length=500, description="sources of its own files")
    team: list[str] = Field(default_factory=list, max_length=50, description="names of the other agents it may call")


class ImportIn(BaseModel):
    files: list[UploadFile] = Field(min_length=1, max_length=2000)
    agents: list[PlannedAgent] = Field(default_factory=list, max_length=200)
    shared: list[str] = Field(default_factory=list, max_length=2000, description="sources to share")


def _texts(files: list[UploadFile]) -> dict[str, str]:
    if sum(len(f.content) for f in files) > MAX_IMPORT:
        raise HTTPException(413, "That's more text than one import takes; import a smaller folder")
    return {f.path: f.content for f in files}


@router.post("/api/import/preview")
def preview(body: PreviewIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """What an import would create. Nothing is saved; the person checks it, then imports."""
    p = importer.plan(_texts(body.files), body.main, body.choices)
    mine = {a.name for a in db.scalars(select(Agent).where(Agent.owner_id == user.id))}
    for a in p["agents"]:
        a["exists"] = a["name"] in mine  # importing again updates it instead of making a copy
    return p


@router.post("/api/import")
def do_import(body: ImportIn, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Create (or update, by name) the agents, and store the shared files. Uses the same path
    rules as the preview, so the sources it returned can be sent back as they are."""
    files = _texts(body.files)
    norm = importer.strip_root(list(files))
    text = {norm[p]: files[p] for p in files}

    def need(source: str) -> tuple[str, str]:
        if source not in text:
            raise HTTPException(422, f"{source} wasn't in the upload")
        path = importer.storable(source)
        return path, text[source]

    created, updated = [], []
    for pa in body.agents:
        if pa.source not in text:
            raise HTTPException(422, f"{pa.source} wasn't in the upload")
        own = []
        for src in pa.files:
            path, content = need(src)
            if path:
                own.append((path, content))
        a = db.scalar(select(Agent).where(Agent.owner_id == user.id, Agent.name == pa.name))
        if a is None:
            a = new_agent(db, user, text[pa.source], pa.name)
            created.append(a)
        else:
            set_file(a, DEFINITION, text[pa.source])
            updated.append(a)
        a.description = importer.describe(text[pa.source])[:2000] or a.description
        for path, content in own:
            if path != DEFINITION:
                set_file(a, path, content)
    db.flush()
    for pa in body.agents:                      # teams, once every agent exists
        if pa.team:
            a = db.scalar(select(Agent).where(Agent.owner_id == user.id, Agent.name == pa.name))
            a.team = [m for m in db.scalars(select(Agent).where(Agent.owner_id == user.id, Agent.name.in_(pa.team)))
                      if m.id != a.id]
    n_shared = 0
    for src in body.shared:
        path, content = need(src)
        if path:
            put_shared(db, user, path, content)
            n_shared += 1
    db.commit()
    return {"created": [owner_view(db, a) for a in created], "updated": [owner_view(db, a) for a in updated],
            "shared": n_shared}



# ---- the agent market -----------------------------------------------------------------------

def _summary(e: dict, installed: set[str]) -> dict:
    return {k: e[k] for k in ("slug", "name", "description", "tags", "author", "color", "building", "tools", "team", "ask")} | {
        "files": len(e["files"]), "lines": sum(f["content"].count("\n") + 1 for f in e["files"]),
        "installed": e["name"] in installed}


@router.get("/api/marketplace")
def market(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Ready-made agents from agents/ in the repo, and which of them you already have."""
    mine = set(db.scalars(select(Agent.name).where(Agent.owner_id == user.id)))
    return [_summary(e, mine) for e in marketplace.catalog().values()]


@router.post("/api/marketplace/{slug}/install")
def install(slug: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Add a market agent to your town (updating it if you have one by that name), and its team."""
    cat = marketplace.catalog()
    if slug not in cat:
        raise HTTPException(404, "No such market agent")
    by_name = {e["name"]: e for e in cat.values()}

    def put(e: dict) -> Agent:
        a = db.scalar(select(Agent).where(Agent.owner_id == user.id, Agent.name == e["name"]))
        md = next(f["content"] for f in e["files"] if f["path"] == "AGENT.md")
        if a is None:
            a = new_agent(db, user, md, e["name"], e["color"] or None)
        else:
            set_file(a, DEFINITION, md)
        a.description = e["description"][:2000]
        a.building = e["building"]
        for f in e["files"]:
            if f["path"] != DEFINITION:
                set_file(a, f["path"], f["content"])
        return a

    entry = cat[slug]
    lead = put(entry)
    added = [lead]
    if entry["team"]:                              # a lead comes with its team (one level, like runs)
        members = [put(by_name[n]) for n in entry["team"] if n in by_name]
        db.flush()
        lead.team = [m for m in members if m.id != lead.id]
        added += members
    db.commit()
    return {"agent": owner_view(db, lead), "added": [a.name for a in added]}
