"""The agent manifest: everything an agent is given when it runs.

This is the contract with the sandbox provider (Modal, later). The sandbox gets this JSON,
writes the files, connects only the listed tools, and starts the agent with AGENT.md as its
instructions. Secrets are NOT in here: a connection's credentials are fetched server-side by
the runtime when it opens that connection, so a manifest can be logged or shown safely.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import views
from .models import Agent, McpConnection, ModelCredential, PublicShare


DEFAULT_MODEL = {"anthropic": "claude-sonnet-5-5", "openai": ""}  # "": the provider's CLI default


def build_manifest(db: Session, a: Agent) -> dict:
    meta, body = views.frontmatter(views.definition(a).content if views.definition(a) else "")

    tools = []
    for g in a.grants:
        c: McpConnection = g.connection
        usable = c.status == "connected" or c.status == "needs_sandbox"
        names = [t.name for t in c.tools] if g.tool_name is None else [g.tool_name]
        tools.append({
            "connection_id": c.id, "connection": c.name, "transport": c.transport,
            "url": c.url, "command": c.command, "status": c.status, "usable": usable,
            "tools": [{"name": t.name, "description": t.description, "input_schema": t.input_schema}
                      for t in c.tools if t.name in names],
            "all_tools": g.tool_name is None,
        })

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
                 "status": cred.status, "model": a.model or DEFAULT_MODEL[cred.provider]}

    return {
        "version": 1,
        # The run is billed to this, the owner's own credential. None: they must add one first.
        "model": model,
        "agent": {"id": a.id, "owner": a.owner.username, "name": a.name, "slug": a.slug,
                  "description": a.description, "frontmatter": meta},
        "instructions": body.strip(),
        "files": [views.file_full(f) for f in a.files],
        "tools": tools,
        "public": public,
    }
