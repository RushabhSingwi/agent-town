"""Gmail and Calendar: signing in with Google, keeping tokens fresh, and the tools a run may call.
Google itself is faked with httpx.MockTransport."""

import base64
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app import google, sandbox
from app.config import settings
from app.models import OAuthAccount

from .conftest import AGENT_MD


class FakeGoogle:
    def __init__(self):
        self.refreshes, self.drafts, self.events, self.revoked = 0, [], [], []
        self.refresh_ok = True

    def __call__(self, req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.startswith(google.TOKEN_URL):
            form = parse_qs(req.content.decode())
            if form["grant_type"] == ["authorization_code"]:
                assert form["code"] == ["the-code"] and form["code_verifier"][0]
                return httpx.Response(200, json={"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600,
                                                 "scope": "openid email " + " ".join(google.SCOPES["gmail"] + google.SCOPES["calendar"])})
            self.refreshes += 1
            if not self.refresh_ok:
                return httpx.Response(400, json={"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
            return httpx.Response(200, json={"access_token": f"at-{self.refreshes + 1}", "expires_in": 3600})
        if url.startswith(google.USERINFO_URL):
            return httpx.Response(200, json={"sub": "g-123", "email": "alice@example.com"})
        if url.startswith(google.REVOKE_URL):
            self.revoked.append(parse_qs(req.content.decode())["token"][0])
            return httpx.Response(200)
        assert req.headers["authorization"].startswith("Bearer at-")
        if url.startswith(f"{google.GMAIL}/messages?"):
            return httpx.Response(200, json={"messages": [{"id": "m1"}]})
        if url.startswith(f"{google.GMAIL}/messages/m1"):
            body = base64.urlsafe_b64encode(b"Lunch on Friday?").decode()
            return httpx.Response(200, json={"id": "m1", "threadId": "t1", "labelIds": ["UNREAD"], "snippet": "Lunch on Friday?",
                                             "payload": {"headers": [{"name": "From", "value": "Sam <sam@example.com>"},
                                                                     {"name": "Subject", "value": "Lunch"},
                                                                     {"name": "Message-ID", "value": "<abc@example.com>"}],
                                                         "mimeType": "text/plain", "body": {"data": body}}})
        if url.startswith(f"{google.GMAIL}/drafts"):
            self.drafts.append(json.loads(req.content))
            return httpx.Response(200, json={"id": "d1"})
        if url.startswith(f"{google.CALENDAR}/events") and req.method == "POST":
            assert "sendUpdates=none" in url
            self.events.append(json.loads(req.content))
            return httpx.Response(200, json={"id": "e1", "htmlLink": "https://calendar.example.com/e1"})
        if url.startswith(f"{google.CALENDAR}/events"):
            return httpx.Response(200, json={"items": [{"id": "e0", "summary": "Standup", "start": {"dateTime": "2026-10-12T09:00:00Z"}}]})
        return httpx.Response(404)


@pytest.fixture
def fake_google(monkeypatch):
    fg = FakeGoogle()
    monkeypatch.setattr(google, "http", lambda: httpx.Client(transport=httpx.MockTransport(fg)))
    monkeypatch.setattr(settings(), "google_client_id", "client-id.apps.googleusercontent.com")
    monkeypatch.setattr(settings(), "google_client_secret", "test-secret")
    monkeypatch.setattr(settings(), "app_url", "http://testserver")
    return fg


def sign_in(c):
    r = c.get("/api/connect/google/start?apps=gmail,calendar", follow_redirects=False)
    assert r.status_code == 303
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["redirect_uri"] == ["http://testserver/api/connect/google/callback"]
    assert q["code_challenge_method"] == ["S256"] and q["access_type"] == ["offline"]
    assert "https://www.googleapis.com/auth/gmail.compose" in q["scope"][0]
    return q["state"][0]


def test_not_set_up(make_user):
    alice = make_user("alice")
    assert alice.get("/api/connect/google").json()["configured"] is False
    assert alice.get("/api/connect/google/start", follow_redirects=False).status_code == 404


def test_sign_in_stores_encrypted_tokens_and_makes_connections(make_user, fake_google, db_session):
    alice = make_user("alice")
    state = sign_in(alice)
    r = alice.get(f"/api/connect/google/callback?state={state}&code=the-code", follow_redirects=False)
    assert r.headers["location"] == "http://testserver/?connected=gmail%2Ccalendar"
    st = alice.get("/api/connect/google").json()
    assert st["accounts"] == [{"id": st["accounts"][0]["id"], "email": "alice@example.com", "status": "connected", "apps": ["gmail", "calendar"]}]
    conns = {c["name"]: c for c in alice.get("/api/city").json()["connections"]}
    assert set(conns) == {"Gmail", "Google Calendar"} and conns["Gmail"]["status"] == "connected"
    assert [t["name"] for t in conns["Gmail"]["tools"]] == ["draft_email", "read_email", "search_emails"]
    with db_session() as s:
        acct = s.query(OAuthAccount).one()
        assert "rt-1" not in acct.refresh_token_enc and "at-1" not in acct.access_token_enc   # encrypted at rest
    # signing in again doesn't duplicate anything
    alice.get(f"/api/connect/google/callback?state={sign_in(alice)}&code=the-code", follow_redirects=False)
    assert len(alice.get("/api/city").json()["connections"]) == 2


def test_callback_must_come_back_to_the_same_browser_and_person(make_user, client, fake_google):
    alice, bob = make_user("alice"), make_user("bob")
    state = sign_in(alice)
    # bob gets alice's link (or alice is tricked into finishing bob's): refused
    r = bob.get(f"/api/connect/google/callback?state={state}&code=the-code", follow_redirects=False)
    assert "connect_error" in r.headers["location"]
    assert bob.get("/api/connect/google").json()["accounts"] == []
    r = alice.get("/api/connect/google/callback?state=garbage&code=the-code", follow_redirects=False)
    assert "expired" in r.headers["location"]
    r = alice.get(f"/api/connect/google/callback?state={sign_in(alice)}&error=access_denied", follow_redirects=False)
    assert "cancelled" in r.headers["location"]


def test_start_must_be_on_the_registered_address(make_user, fake_google, monkeypatch):
    monkeypatch.setattr(settings(), "app_url", "https://agenttown.example.com")
    r = make_user("alice").get("/api/connect/google/start", follow_redirects=False)
    assert r.status_code == 400 and "agenttown.example.com" in r.json()["detail"]


class FakeProvider:
    started: list = []
    def start(self, run_id, token): self.started.append(token); return "fake"
    def stop(self, sid): pass
    def alive(self, sid): return True


def run_with_gmail(alice, client, monkeypatch, tool=None):
    FakeProvider.started = []
    monkeypatch.setattr(sandbox, "provider", lambda name=None: FakeProvider())
    alice.post("/api/account/credentials", json={"provider": "anthropic", "kind": "subscription", "secret": "sk-ant-oat01-" + "x" * 40})
    a = alice.post("/api/agents", json={"markdown": AGENT_MD}).json()
    gmail = next(c for c in alice.get("/api/city").json()["connections"] if c["name"] == "Gmail")
    alice.put(f"/api/agents/{a['id']}/grants", json={"grants": [{"connection_id": gmail["id"], "tool_name": tool}]})
    alice.post(f"/api/agents/{a['id']}/runs")
    token = FakeProvider.started[0]
    client.cookies.clear()
    client.headers["Authorization"] = f"Bearer {token}"
    return client, gmail


def rpc(c, conn_id, method, params=None, mid=1):
    return c.post(f"/api/runtime/mcp/{conn_id}", json={"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})


def test_a_run_uses_gmail_through_agent_town(make_user, client, fake_google, monkeypatch):
    alice = make_user("alice")
    alice.get(f"/api/connect/google/callback?state={sign_in(alice)}&code=the-code", follow_redirects=False)
    sb, gmail = run_with_gmail(alice, client, monkeypatch)

    setup = sb.get("/api/runtime/setup").json()
    [tool] = setup["manifest"]["tools"]
    assert tool["hosted"] and tool["server"] == "gmail" and tool["url"].endswith(f"/api/runtime/mcp/{gmail['id']}")
    assert setup["auth_headers"] == {}                       # no Google token goes to the sandbox
    assert "at-1" not in json.dumps(setup) and "rt-1" not in json.dumps(setup)

    assert rpc(sb, gmail["id"], "initialize").json()["result"]["serverInfo"]["name"] == "agent-town-gmail"
    assert len(rpc(sb, gmail["id"], "tools/list").json()["result"]["tools"]) == 3
    found = json.loads(rpc(sb, gmail["id"], "tools/call", {"name": "search_emails", "arguments": {"query": "is:unread"}})
                       .json()["result"]["content"][0]["text"])
    assert found["emails"][0]["from"] == "Sam <sam@example.com>" and found["emails"][0]["unread"] is True
    read = json.loads(rpc(sb, gmail["id"], "tools/call", {"name": "read_email", "arguments": {"id": "m1"}}).json()["result"]["content"][0]["text"])
    assert read["body"] == "Lunch on Friday?"
    r = rpc(sb, gmail["id"], "tools/call", {"name": "draft_email", "arguments": {"to": "sam@example.com", "body": "Yes!", "reply_to_id": "m1"}})
    assert "Nothing was sent" in r.json()["result"]["content"][0]["text"]
    raw = base64.urlsafe_b64decode(fake_google.drafts[0]["message"]["raw"] + "==").decode()
    assert "In-Reply-To: <abc@example.com>" in raw and "Subject: Re: Lunch" in raw
    assert fake_google.drafts[0]["message"]["threadId"] == "t1"
    # a calendar tool on the gmail connection, or a connection it wasn't granted: no
    assert "error" in rpc(sb, gmail["id"], "tools/call", {"name": "create_event", "arguments": {}}).json()
    cal = next(c for c in alice.get("/api/city").json()["connections"] if c["name"] == "Google Calendar")
    assert rpc(sb, cal["id"], "tools/list").status_code == 404


def test_only_granted_tools(make_user, client, fake_google, monkeypatch):
    alice = make_user("alice")
    alice.get(f"/api/connect/google/callback?state={sign_in(alice)}&code=the-code", follow_redirects=False)
    sb, gmail = run_with_gmail(alice, client, monkeypatch, tool="search_emails")
    assert [t["name"] for t in rpc(sb, gmail["id"], "tools/list").json()["result"]["tools"]] == ["search_emails"]
    assert "error" in rpc(sb, gmail["id"], "tools/call", {"name": "draft_email", "arguments": {"to": "x", "body": "y"}}).json()


def test_tokens_refresh_and_expire(make_user, client, fake_google, monkeypatch, db_session):
    alice = make_user("alice")
    alice.get(f"/api/connect/google/callback?state={sign_in(alice)}&code=the-code", follow_redirects=False)
    sb, gmail = run_with_gmail(alice, client, monkeypatch)
    with db_session() as s:                                   # the hour is up
        s.query(OAuthAccount).one().expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        s.commit()
    rpc(sb, gmail["id"], "tools/call", {"name": "search_emails", "arguments": {}})
    assert fake_google.refreshes == 1
    with db_session() as s:
        s.query(OAuthAccount).one().expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        s.commit()
    fake_google.refresh_ok = False                            # revoked, or a Testing-mode token past 7 days
    r = rpc(sb, gmail["id"], "tools/call", {"name": "search_emails", "arguments": {}}).json()["result"]
    assert r["isError"] and "connect it again" in r["content"][0]["text"]
    alice.headers.pop("Authorization", None)
    assert alice.get("/api/connect/google").json()["accounts"][0]["status"] == "expired"
    assert next(c for c in alice.get("/api/city").json()["connections"] if c["name"] == "Gmail")["status"] == "auth_required"


def test_disconnect_revokes_and_removes_access(make_user, fake_google):
    alice, bob = make_user("alice"), make_user("bob")
    alice.get(f"/api/connect/google/callback?state={sign_in(alice)}&code=the-code", follow_redirects=False)
    acct = alice.get("/api/connect/google").json()["accounts"][0]
    assert bob.delete(f"/api/connect/google/{acct['id']}").status_code == 404
    assert alice.delete(f"/api/connect/google/{acct['id']}").json() == {"ok": True}
    assert fake_google.revoked == ["rt-1"]
    assert alice.get("/api/city").json()["connections"] == []


def test_deleting_the_account_revokes_google(make_user, fake_google):
    alice = make_user("alice")
    alice.get(f"/api/connect/google/callback?state={sign_in(alice)}&code=the-code", follow_redirects=False)
    assert alice.request("DELETE", "/api/account", json={"password": "correct horse battery"}).status_code == 200
    assert fake_google.revoked == ["rt-1"]


def test_connecting_from_an_agent_gives_it_access_and_a_fresh_chat(make_user, client, fake_google, monkeypatch):
    alice = make_user("alice")
    a = alice.post("/api/agents", json={"markdown": AGENT_MD}).json()
    r = alice.get(f"/api/connect/google/start?apps=gmail&agent={a['id']}", follow_redirects=False)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    alice.get(f"/api/connect/google/callback?state={state}&code=the-code", follow_redirects=False)
    grants = alice.get(f"/api/agents/{a['id']}").json()["grants"]
    assert len(grants) == 2 and all(g["tool_name"] is None for g in grants)       # Gmail and Calendar, all tools
    # someone else's agent id in the link gets nothing
    bob = make_user("bob")
    b = bob.post("/api/agents", json={"markdown": AGENT_MD}).json()
    r = alice.get(f"/api/connect/google/start?apps=gmail&agent={b['id']}", follow_redirects=False)
    state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
    alice.get(f"/api/connect/google/callback?state={state}&code=the-code", follow_redirects=False)
    assert bob.get(f"/api/agents/{b['id']}").json()["grants"] == []
