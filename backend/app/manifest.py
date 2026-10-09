"""The agent manifest: everything an agent is given when it runs.

This is the contract with the sandbox (runner/runner.py). The sandbox gets this JSON,
writes the files, connects only the listed tools, and starts the agent with AGENT.md as its
instructions. Secrets are NOT in here: the sandbox fetches the model credential and MCP auth headers
separately (/api/runtime/setup, with its run token), so a manifest can be logged or shown safely.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import views
from .config import settings
from .models import DEFINITION, Agent, McpConnection, ModelCredential, PublicShare, SharedFile


DEFAULT_MODEL = {"anthropic": "claude-sonnet-5-5", "openai": ""}  # "": the provider's CLI default
# Thinking effort, from quick to thorough. Claude Code takes these as --effort; Codex has no "max",
# so the runner caps it at "xhigh" there.
EFFORTS = ("low", "medium", "high", "xhigh", "max")


def granted_tools(a: Agent) -> list[dict]:
    tools = []
    for g in a.grants:
        c: McpConnection = g.connection
        usable = c.status == "connected" or c.status == "needs_sandbox"
        names = [t.name for t in c.tools] if g.tool_name is None else [g.tool_name]
        hosted = c.transport == "hosted"          # Gmail, Calendar: served by Agent Town, reached with the run token
        tools.append({
            "connection_id": c.id, "connection": c.name, "transport": "http" if hosted else c.transport,
            "url": f"{settings().public_url.rstrip('/')}/api/runtime/mcp/{c.id}" if hosted else c.url,
            "hosted": hosted, "server": c.app if hosted else None,     # hosted: mcp__gmail__…, mcp__calendar__…
            "command": c.command, "status": c.status, "usable": usable,
            "tools": [{"name": t.name, "description": t.description, "input_schema": t.input_schema}
                      for t in c.tools if t.name in names],
            "all_tools": g.tool_name is None,
        })
    return tools


def build_manifest(db: Session, a: Agent) -> dict:
    meta, body = views.frontmatter(views.definition(a).content if views.definition(a) else "")
    tools = granted_tools(a)

    # its team: each member as a sub-agent, with its own instructions, files and tools (one level deep)
    team = []
    for m in a.team:
        m_meta, m_body = views.frontmatter(views.definition(m).content if views.definition(m) else "")
        team.append({"id": m.id, "name": m.name, "slug": m.slug, "description": m.description or m_meta.get("description", ""),
                     "instructions": m_body.strip(), "tools": granted_tools(m),
                     "files": [views.file_full(f) for f in m.files if f.path != DEFINITION]})

    public = []
    if a.can_use_public:
        for s in db.scalars(select(PublicShare).where(PublicShare.allow_agent_use.is_(True))
                            .order_by(PublicShare.created_at)):
            item = views.share(s, with_content=True)
            if s.kind == "agent" and s.agent_id == a.id:
                continue
            public.append(item)

    cred = db.get(ModelCredential, a.model_credential_id) if a.model_credential_id else db.scalar(
        select(ModelCredential).where(ModelCredential.owner_id == a.owner_id, ModelCredential.is_default.is_(True)))
    model = None
    if cred:
        model = {"credential_id": cred.id, "provider": cred.provider, "kind": cred.kind,
                 "status": cred.status, "model": a.model or DEFAULT_MODEL[cred.provider], "thinking": a.thinking}

    return {
        "version": 1,
        # The run is billed to this, the owner's own credential. None: they must add one first.
        "model": model,
        "agent": {"id": a.id, "owner": a.owner.username, "name": a.name, "slug": a.slug,
                  "description": a.description, "frontmatter": meta},
        "instructions": body.strip(),
        "files": [views.file_full(f) for f in a.files],
        # the owner's shared files: every one of their agents gets these
        "shared": [{"path": f.path, "lines": f.lines, "content": f.content} for f in db.scalars(
            select(SharedFile).where(SharedFile.owner_id == a.owner_id).order_by(SharedFile.path))],
        "tools": tools,
        "team": team,
        "public": public,
    }
