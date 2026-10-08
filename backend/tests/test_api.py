from fastapi.testclient import TestClient

from app import mcp_client
from app.routers import mcp as mcp_router
from dev.demo_mcp_server import app as demo_app

from .conftest import AGENT_MD


# ---- auth ------------------------------------------------------------------------------

def test_signup_login_logout(client):
    r = client.post("/api/auth/signup", json={"email": "A@Example.com", "username": "alice",
                                              "password": "correct horse battery"})
    assert r.status_code == 200
    assert client.get("/api/auth/me").json()["username"] == "alice"
    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/me").json() is None
    assert client.post("/api/auth/login", json={"login": "a@example.com", "password": "nope-nope"}).status_code == 401
    assert client.post("/api/auth/login", json={"login": "alice", "password": "correct horse battery"}).status_code == 200
    assert client.get("/api/auth/me").json()["email"] == "a@example.com"


def test_duplicate_signup(client, make_user):
    make_user("alice")
    r = client.post("/api/auth/signup", json={"email": "alice@example.com", "username": "other",
                                              "password": "correct horse battery"})
    assert r.status_code == 409


def test_writes_need_a_session_and_same_origin(client, make_user):
    assert client.post("/api/agents", json={"markdown": AGENT_MD}).status_code == 401
    alice = make_user("alice")
    r = alice.post("/api/agents", json={"markdown": AGENT_MD}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


# ---- agents are private until shared ---------------------------------------------------------

def test_agent_from_frontmatter_and_privacy(client, make_user):
    alice, bob = make_user("alice"), make_user("bob")
    a = alice.post("/api/agents", json={"markdown": AGENT_MD,
                                        "files": [{"path": "playbook.md", "content": "a\nb\nc\n"}]}).json()
    assert a["name"] == "reel-writer" and a["description"] == "Scripts short videos."
    assert [f["path"] for f in a["files"]] == ["AGENT.md", "playbook.md"]
    assert a["files"][1]["lines"] == 3

    assert bob.get(f"/api/agents/{a['id']}").status_code == 404
    assert client.get(f"/api/agents/{a['id']}").status_code == 404
    assert bob.get("/api/city").json()["agents"] == []
    assert bob.patch(f"/api/agents/{a['id']}", json={"name": "mine now"}).status_code == 404
    assert bob.delete(f"/api/agents/{a['id']}").status_code == 404


def test_share_agent_and_file(client, make_user):
    alice, bob = make_user("alice"), make_user("bob")
    a = alice.post("/api/agents", json={"markdown": AGENT_MD,
                                        "files": [{"path": "playbook.md", "content": "tips\n"}]}).json()
    playbook = a["files"][1]["id"]

    assert bob.post("/api/public", json={"kind": "agent", "agent_id": a["id"]}).status_code == 404
    s = alice.post("/api/public", json={"kind": "agent", "agent_id": a["id"], "note": "use for reels"}).json()
    alice.post("/api/public", json={"kind": "file", "file_id": playbook})

    shares = client.get("/api/public").json()
    assert [x["kind"] for x in shares] == ["agent", "file"] and shares[0]["owner"] == "alice"
    assert client.get(f"/api/agents/{a['id']}").json()["files"][0]["content"].startswith("---")

    assert bob.delete(f"/api/public/{s['id']}").status_code == 404
    assert alice.delete(f"/api/public/{s['id']}").status_code == 200
    assert client.get(f"/api/agents/{a['id']}").status_code == 404


# ---- tools ------------------------------------------------------------------------------

def demo_check(monkeypatch):
    """Point connection checks at the in-process demo MCP server."""
    real = mcp_client.check
    monkeypatch.setattr(mcp_router.mcp_client, "check",
                        lambda url, auth=None, allow_private=False: real(url, auth, allow_private=True,
                                                                         client=TestClient(demo_app)))


def test_mcp_check_json_and_sse():
    for url in ("http://testserver/mcp", "http://testserver/mcp?sse=1"):
        r = mcp_client.check(url, allow_private=True, client=TestClient(demo_app))
        assert r.status == "connected", r.detail
        assert r.server_name == "demo-mcp"
        assert [t["name"] for t in r.tools] == ["echo", "utc_now", "word_count"]


def test_mcp_auth_required(monkeypatch):
    monkeypatch.setenv("DEMO_MCP_TOKEN", "s3cret")
    r = mcp_client.check("http://testserver/mcp", allow_private=True, client=TestClient(demo_app))
    assert r.status == "auth_required"
    r = mcp_client.check("http://testserver/mcp", "Bearer s3cret", allow_private=True, client=TestClient(demo_app))
    assert r.status == "connected"


def test_ssrf_guard():
    r = mcp_client.check("http://127.0.0.1:9/mcp", allow_private=False)
    assert r.status == "error" and "private address" in r.detail


def test_grants_and_manifest(monkeypatch, make_user):
    demo_check(monkeypatch)
    alice, bob = make_user("alice"), make_user("bob")
    conn = alice.post("/api/mcp", json={"name": "demo", "url": "http://testserver/mcp",
                                        "auth_header": "Bearer xyz"}).json()
    assert conn["status"] == "connected" and len(conn["tools"]) == 3
    assert conn["has_auth"] and "auth_header" not in conn

    a = alice.post("/api/agents", json={"markdown": AGENT_MD}).json()
    other = alice.post("/api/agents", json={"markdown": AGENT_MD, "name": "helper"}).json()
    r = alice.put(f"/api/agents/{a['id']}/grants",
                  json={"grants": [{"connection_id": conn["id"], "tool_name": "echo"}]})
    assert r.json()["grants"] == [{"connection_id": conn["id"], "tool_name": "echo"}]
    assert alice.put(f"/api/agents/{a['id']}/grants", json={"grants": [
        {"connection_id": conn["id"], "tool_name": "rm_rf"}]}).status_code == 422

    b = bob.post("/api/agents", json={"markdown": AGENT_MD}).json()
    assert bob.put(f"/api/agents/{b['id']}/grants",
                   json={"grants": [{"connection_id": conn["id"]}]}).status_code == 404

    alice.post("/api/public", json={"kind": "agent", "agent_id": other["id"], "note": "ask me"})
    alice.post("/api/public", json={"kind": "agent", "agent_id": a["id"], "allow_agent_use": False})

    m = alice.get(f"/api/agents/{a['id']}/manifest").json()
    assert m["instructions"].startswith("# Reel writer")
    assert [t["name"] for t in m["tools"][0]["tools"]] == ["echo"]
    assert "Bearer" not in str(m)
    assert [p["title"] for p in m["public"]] == ["helper"]  # not itself, not a no-agent-use share

    bm = bob.get(f"/api/agents/{b['id']}/manifest").json()
    assert bm["tools"] == [] and [p["title"] for p in bm["public"]] == ["helper"]
    bob.patch(f"/api/agents/{b['id']}", json={"can_use_public": False})
    assert bob.get(f"/api/agents/{b['id']}/manifest").json()["public"] == []
    assert bob.get(f"/api/agents/{a['id']}/manifest").status_code == 404


def test_stdio_needs_sandbox(make_user):
    alice = make_user("alice")
    c = alice.post("/api/mcp", json={"name": "gmail", "transport": "stdio",
                                     "command": "npx @gongrzhe/server-gmail-autoauth-mcp"}).json()
    assert c["status"] == "needs_sandbox"
