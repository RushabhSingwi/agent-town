"""A tiny MCP server over Streamable HTTP, written by hand so you can see the protocol.

    uv run uvicorn dev.demo_mcp_server:app --port 8765

Then add it in Agent Town as an http connection with url http://127.0.0.1:8765/mcp
(start the API with AGENTTOWN_ALLOW_PRIVATE_MCP_HOSTS=true, since it's on localhost).
Set DEMO_MCP_TOKEN=secret to make it demand "Authorization: Bearer secret".
Add ?sse=1 to the URL to get answers as an SSE stream instead of plain JSON.
"""

import json
import os
import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

app = FastAPI(title="demo MCP server")
SESSIONS: set[str] = set()

TOOLS = [
    {"name": "echo", "description": "Repeat the text back.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "utc_now", "description": "The current time in UTC.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "word_count", "description": "Count the words in a piece of text.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
]


def call(name: str, args: dict) -> str:
    if name == "echo":
        return str(args.get("text", ""))
    if name == "utc_now":
        return datetime.now(timezone.utc).isoformat()
    if name == "word_count":
        return str(len(str(args.get("text", "")).split()))
    raise KeyError(name)


def reply(msg: dict, sse: bool, headers: dict | None = None) -> Response:
    if sse:
        return Response(f"event: message\ndata: {json.dumps(msg)}\n\n", media_type="text/event-stream",
                        headers=headers)
    return JSONResponse(msg, headers=headers)


@app.post("/mcp")
async def mcp(request: Request):
    token = os.environ.get("DEMO_MCP_TOKEN")
    if token and request.headers.get("authorization") != f"Bearer {token}":
        return JSONResponse({"error": "unauthorized"}, status_code=401,
                            headers={"WWW-Authenticate": 'Bearer realm="demo"'})
    sse = request.query_params.get("sse") == "1"
    msg = await request.json()
    method, mid = msg.get("method"), msg.get("id")

    if mid is None:  # a notification, e.g. notifications/initialized: acknowledge, no body
        return Response(status_code=202)
    if method == "initialize":
        sid = uuid.uuid4().hex
        SESSIONS.add(sid)
        return reply({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "demo-mcp", "version": "0.1.0"}}}, sse, {"Mcp-Session-Id": sid})
    if request.headers.get("mcp-session-id") not in SESSIONS:
        return JSONResponse({"jsonrpc": "2.0", "id": mid, "error": {"code": -32600, "message": "No session"}},
                            status_code=404)
    if method == "tools/list":
        return reply({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}, sse)
    if method == "tools/call":
        p = msg.get("params") or {}
        try:
            text = call(p.get("name", ""), p.get("arguments") or {})
        except KeyError:
            return reply({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "Unknown tool"}}, sse)
        return reply({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}]}}, sse)
    return reply({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"No method {method}"}}, sse)


@app.delete("/mcp")
async def end(request: Request):
    SESSIONS.discard(request.headers.get("mcp-session-id", ""))
    return Response(status_code=204)
