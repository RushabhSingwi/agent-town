"""Tools Agent Town hosts itself (Gmail, Calendar), served over MCP to a run's sandbox.

    POST /api/runtime/mcp/{connection_id}     JSON-RPC: initialize, tools/list, tools/call

The sandbox authenticates with its run token, like the rest of /api/runtime. A run may only use a
connection its agent (or a teammate) was granted, and only the tools granted; then the call is made
here with the owner's Google token, which never leaves this server.
"""

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from .. import google
from ..db import get_db
from ..models import McpConnection, OAuthAccount, Run
from .runs import current_run

router = APIRouter(tags=["runtime"])


def allowed_tools(r: Run, conn_id: int) -> set[str] | None:
    """The tool names this run may call on that connection: None means all of them, an empty set none."""
    names: set[str] = set()
    for agent in [r.agent, *r.agent.team]:
        for g in agent.grants:
            if g.connection_id == conn_id:
                if g.tool_name is None:
                    return None
                names.add(g.tool_name)
    return names


def _reply(mid, result=None, error: tuple[int, str] | None = None) -> JSONResponse:
    body = {"jsonrpc": "2.0", "id": mid}
    body.update({"error": {"code": error[0], "message": error[1]}} if error else {"result": result})
    return JSONResponse(body)


@router.post("/api/runtime/mcp/{connection_id}")
def mcp(connection_id: int, msg: dict = Body(...), r: Run = Depends(current_run), db: Session = Depends(get_db)):
    """Not async: tool calls wait on Google, and FastAPI runs plain functions in a worker thread."""
    conn = db.get(McpConnection, connection_id)
    allowed = allowed_tools(r, connection_id) if conn and conn.owner_id == r.owner_id else set()
    if conn is None or conn.transport != "hosted" or allowed == set():
        return JSONResponse({"error": "No such connection for this run"}, status_code=404)
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:                                   # notifications: nothing to say back
        return Response(status_code=202)
    tools = [t for t in google.TOOLS.get(conn.app, []) if allowed is None or t["name"] in allowed]
    if method == "initialize":
        return _reply(mid, {"protocolVersion": (msg.get("params") or {}).get("protocolVersion", "2025-06-18"),
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": f"agent-town-{conn.app}", "version": "1.0"}})
    if method == "tools/list":
        return _reply(mid, {"tools": tools})
    if method == "tools/call":
        p = msg.get("params") or {}
        name, args = p.get("name", ""), p.get("arguments") or {}
        if name not in {t["name"] for t in tools}:
            return _reply(mid, error=(-32602, f"{name!r} isn't one of this connection's tools"))
        acct = db.get(OAuthAccount, conn.oauth_account_id)
        try:
            result = google.call(db, acct, conn.app, name, args)
            return _reply(mid, {"content": [{"type": "text", "text": google.tool_text(result)}]})
        except google.Expired:
            conn.status, conn.status_detail = "auth_required", "Google sign-in expired: connect again"
            db.commit()
            return _reply(mid, {"isError": True, "content": [{"type": "text", "text":
                              "The Google sign-in for this app has expired. Ask the person to connect it again in Agent Town."}]})
        except (google.GoogleError, KeyError, ValueError) as e:
            return _reply(mid, {"isError": True, "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}]})
    if method == "ping":
        return _reply(mid, {})
    return _reply(mid, error=(-32601, f"No method {method}"))
