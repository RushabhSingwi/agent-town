"""The agent manifest: everything an agent is given when it runs.

This is the contract with the sandbox provider (Modal, later). The sandbox gets this JSON,
writes the files, connects only the listed tools, and starts the agent with AGENT.md as its
instructions. Secrets are NOT in here: a connection's credentials are fetched server-side by
the runtime when it opens that connection, so a manifest can be logged or shown safely.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import views
from .models import Agent, McpConnection, PublicShare


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

    return {
        "version": 1,
        "agent": {"id": a.id, "owner": a.owner.username, "name": a.name, "slug": a.slug,
                  "description": a.description, "frontmatter": meta},
        "instructions": body.strip(),
        "files": [views.file_full(f) for f in a.files],
        "tools": tools,
        "public": public,
    }
