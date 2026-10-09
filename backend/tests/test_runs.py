"""Runs: the owner opens a chat, the sandbox (played here by the test) fetches its setup with the
run token, reads the owner's messages and posts back what the agent did."""

import pytest

from app import sandbox
from app.routers import runs as runs_router

from .conftest import AGENT_MD

OAT = "sk-ant-oat01-" + "x" * 40


class FakeProvider:
    name = "fake"
    started: list[tuple[int, str]] = []
    stopped: list[str] = []

    def start(self, run_id, token):
        self.started.append((run_id, token))
        return f"fake-{run_id}"

    def stop(self, sandbox_id):
        self.stopped.append(sandbox_id)

    def alive(self, sandbox_id):
        return sandbox_id not in self.dead

    dead: set = set()


@pytest.fixture(autouse=True)
def fake_sandbox(monkeypatch):
    FakeProvider.started, FakeProvider.stopped = [], []
    monkeypatch.setattr(sandbox, "provider", lambda name=None: FakeProvider())
    return FakeProvider


def setup_agent(c, with_key=True):
    a = c.post("/api/agents", json={"markdown": AGENT_MD, "files": [{"path": "notes.md", "content": "hi\n"}]}).json()
    if with_key:
        r = c.post("/api/account/credentials", json={"provider": "anthropic", "kind": "subscription", "secret": OAT})
        assert r.status_code == 200, r.text
    return a


def box(client, token):
    """A client that talks like the sandbox: only the run token, no cookie."""
    client.cookies.clear()
    client.headers["Authorization"] = f"Bearer {token}"
    return client


def test_run_round_trip(make_user, client, fake_sandbox):
    alice = make_user("alice")
    a = setup_agent(alice)
    r = alice.post(f"/api/agents/{a['id']}/runs")
    assert r.status_code == 202 and r.json()["status"] == "starting"
    run_id = r.json()["id"]
    [(started_id, token)] = fake_sandbox.started
    assert started_id == run_id and token.startswith("rt_")

    sb = box(client, token)
    setup = sb.get("/api/runtime/setup").json()
    assert setup["credential"] == {"provider": "anthropic", "kind": "subscription", "secret": OAT,
                                   "model": "claude-sonnet-5-5"}
    assert setup["manifest"]["instructions"].startswith("# Reel writer")
    assert OAT not in str(setup["manifest"])  # the manifest itself stays secret-free

    assert sb.post("/api/runtime/events", json={"events": [{"kind": "status", "data": {"status": "ready"}}]}).status_code == 200
    assert alice.get(f"/api/runs/{run_id}").json()["status"] == "ready"

    sent = alice.post(f"/api/runs/{run_id}/messages", json={"text": "write a hook"}).json()
    inbox = sb.get("/api/runtime/inbox?after=0").json()
    assert inbox["messages"] == [{"id": sent["id"], "text": "write a hook"}]
    assert sb.get(f"/api/runtime/inbox?after={sent['id']}").json()["messages"] == []

    sb.post("/api/runtime/events", json={"events": [
        {"kind": "tool", "data": {"name": "Read", "input": "notes.md"}},
        {"kind": "text", "data": {"text": "POV: you finally…"}},
        {"kind": "done", "data": {"ok": True}}]})
    kinds = [e["kind"] for e in alice.get(f"/api/runs/{run_id}/events").json()["events"]]
    assert kinds == ["status", "user", "tool", "text", "done"]
    after = alice.get(f"/api/runs/{run_id}/events?after={sent['id']}").json()["events"]
    assert [e["kind"] for e in after] == ["tool", "text", "done"]

    # a subscription token is verified by its first successful turn
    cred = alice.get("/api/account/credentials").json()["credentials"][0]
    assert cred["status"] == "valid"

    # the sandbox can't post as the owner
    assert sb.post("/api/runtime/events", json={"events": [{"kind": "user", "data": {"text": "x"}}]}).status_code == 422

    # stopping ends the token at once and tears the box down
    assert alice.delete(f"/api/runs/{run_id}").json()["status"] == "stopped"
    assert fake_sandbox.stopped == [f"fake-{run_id}"]
    assert sb.get("/api/runtime/inbox").status_code == 401
    assert alice.post(f"/api/runs/{run_id}/messages", json={"text": "hi"}).status_code == 409


def test_rejected_credential_is_marked_invalid(make_user, client, fake_sandbox):
    alice = make_user("alice")
    a = setup_agent(alice)
    alice.post(f"/api/agents/{a['id']}/runs")
    sb = box(client, fake_sandbox.started[0][1])
    sb.post("/api/runtime/events", json={"events": [{"kind": "done", "data": {"ok": False, "auth_failed": True}}]})
    alice.headers.pop("Authorization", None)
    assert alice.get("/api/account/credentials").json()["credentials"][0]["status"] == "invalid"


def test_open_run_is_reused(make_user, fake_sandbox):
    alice = make_user("alice")
    a = setup_agent(alice)
    assert alice.get(f"/api/agents/{a['id']}/runs/active").json() is None  # looking starts nothing
    assert fake_sandbox.started == []
    first = alice.post(f"/api/agents/{a['id']}/runs").json()
    assert alice.get(f"/api/agents/{a['id']}/runs/active").json()["id"] == first["id"]
    assert make_user("bob").get(f"/api/agents/{a['id']}/runs/active").status_code == 404
    assert alice.post(f"/api/agents/{a['id']}/runs").json()["id"] == first["id"]
    assert len(fake_sandbox.started) == 1


def test_run_needs_a_model_credential(make_user):
    alice = make_user("alice")
    a = setup_agent(alice, with_key=False)
    assert alice.post(f"/api/agents/{a['id']}/runs").status_code == 422


def test_runner_can_end_its_own_run(make_user, client, fake_sandbox):
    alice = make_user("alice")
    a = setup_agent(alice)
    run_id = alice.post(f"/api/agents/{a['id']}/runs").json()["id"]
    sb = box(client, fake_sandbox.started[0][1])
    sb.post("/api/runtime/events", json={"events": [{"kind": "status", "data": {"status": "stopped", "detail": "idle"}}]})
    r = alice.get(f"/api/runs/{run_id}").json()
    assert r["status"] == "stopped" and r["ended_at"]
    assert sb.get("/api/runtime/setup").status_code == 401


def test_provider_failure_is_reported(make_user, monkeypatch):
    class Broken(FakeProvider):
        def start(self, run_id, token):
            raise RuntimeError("no capacity")
    monkeypatch.setattr(sandbox, "provider", lambda name=None: Broken())
    alice = make_user("alice")
    a = setup_agent(alice)
    run_id = alice.post(f"/api/agents/{a['id']}/runs").json()["id"]
    r = alice.get(f"/api/runs/{run_id}").json()
    assert r["status"] == "error" and "no capacity" in r["detail"]


def test_runs_are_private(make_user, client, fake_sandbox):
    alice, bob = make_user("alice"), make_user("bob")
    a = setup_agent(alice)
    run_id = alice.post(f"/api/agents/{a['id']}/runs").json()["id"]
    assert bob.post(f"/api/agents/{a['id']}/runs").status_code == 404
    assert bob.get(f"/api/runs/{run_id}").status_code == 404
    assert bob.get(f"/api/runs/{run_id}/events").status_code == 404
    assert bob.post(f"/api/runs/{run_id}/messages", json={"text": "hi"}).status_code == 404
    assert bob.delete(f"/api/runs/{run_id}").status_code == 404

    # a run token is not an API token, and an API token is not a run token
    sb = box(client, fake_sandbox.started[0][1])
    assert sb.get("/api/agents").status_code == 401
    at = alice.post("/api/account/tokens", json={"name": "cli"}).json()["token"]
    alice.cookies.clear()
    alice.headers["Authorization"] = f"Bearer {at}"
    assert alice.get("/api/runtime/setup").status_code == 401
    assert alice.get(f"/api/runs/{run_id}").status_code == 200  # but the owner's token can watch the run


def test_sandbox_that_dies_while_starting_is_reported(make_user, fake_sandbox, db_session):
    from datetime import datetime, timedelta, timezone
    from app.models import Run
    alice = make_user("alice")
    a = setup_agent(alice)
    run_id = alice.post(f"/api/agents/{a['id']}/runs").json()["id"]
    FakeProvider.dead = {f"fake-{run_id}"}
    with db_session() as s:
        s.get(Run, run_id).created_at = datetime.now(timezone.utc) - timedelta(seconds=20)
        s.commit()
    r = alice.get(f"/api/runs/{run_id}").json()
    FakeProvider.dead = set()
    assert r["status"] == "error" and "before it could reach Agent Town" in r["detail"]


def test_unreachable_public_url_fails_fast(make_user, monkeypatch):
    monkeypatch.setattr(runs_router, "reachable_problem", lambda: "nothing answers there")
    alice = make_user("alice")
    a = setup_agent(alice)
    r = alice.post(f"/api/agents/{a['id']}/runs")
    assert r.status_code == 503 and "nothing answers" in r.json()["detail"]


def test_silent_sandbox_is_reaped(make_user, client, fake_sandbox, db_session):
    from datetime import datetime, timedelta, timezone
    from app.models import Run
    alice = make_user("alice")
    a = setup_agent(alice)
    run_id = alice.post(f"/api/agents/{a['id']}/runs").json()["id"]
    sb = box(client, fake_sandbox.started[0][1])
    sb.post("/api/runtime/events", json={"events": [{"kind": "status", "data": {"status": "ready"}}]})
    with db_session() as s:
        s.get(Run, run_id).last_seen_at = datetime.now(timezone.utc) - runs_router.SILENCE - timedelta(seconds=5)
        s.commit()
    r = alice.get(f"/api/runs/{run_id}").json()
    assert r["status"] == "error" and "stopped responding" in r["detail"]
    assert fake_sandbox.stopped == [f"fake-{run_id}"]


def test_sandbox_gets_the_teams_tool_credentials(make_user, client, fake_sandbox, monkeypatch):
    from app import mcp_client
    from app.routers import mcp as mcp_router
    monkeypatch.setattr(mcp_router.mcp_client, "check", lambda *a, **k: mcp_client.CheckResult("connected", "ok", "s", "1", [{"name": "t"}]))
    alice = make_user("alice")
    lead = setup_agent(alice)
    member = alice.post("/api/agents", json={"markdown": "---\nname: helper\n---\nHelp."}).json()
    conn = alice.post("/api/mcp", json={"name": "mail", "url": "https://mail.example/mcp", "auth_header": "Bearer m"}).json()
    alice.put(f"/api/agents/{member['id']}/grants", json={"grants": [{"connection_id": conn["id"], "tool_name": None}]})
    alice.put(f"/api/agents/{lead['id']}/team", json={"member_ids": [member["id"]]})
    alice.post(f"/api/agents/{lead['id']}/runs")
    setup = box(client, fake_sandbox.started[0][1]).get("/api/runtime/setup").json()
    assert [t["slug"] for t in setup["manifest"]["team"]] == ["helper"]
    assert setup["manifest"]["tools"] == []                          # the lead itself has no tools…
    assert setup["auth_headers"] == {str(conn["id"]): "Bearer m"}     # …but its teammate's credentials come along


def test_deleting_the_account_stops_its_sandboxes(make_user, fake_sandbox):
    alice = make_user("alice")
    a = setup_agent(alice)
    run_id = alice.post(f"/api/agents/{a['id']}/runs").json()["id"]
    assert alice.request("DELETE", "/api/account", json={"password": "correct horse battery"}).status_code == 200
    assert fake_sandbox.stopped == [f"fake-{run_id}"]


def test_changing_apps_or_team_ends_the_open_chat(make_user, fake_sandbox, monkeypatch):
    from app import mcp_client
    from app.routers import mcp as mcp_router
    monkeypatch.setattr(mcp_router.mcp_client, "check", lambda *a, **k: mcp_client.CheckResult("connected", "ok", "s", "1", [{"name": "t"}]))
    alice = make_user("alice")
    a = setup_agent(alice)
    conn = alice.post("/api/mcp", json={"name": "mail", "url": "https://mail.example/mcp"}).json()
    run_id = alice.post(f"/api/agents/{a['id']}/runs").json()["id"]
    alice.put(f"/api/agents/{a['id']}/grants", json={"grants": [{"connection_id": conn["id"], "tool_name": None}]})
    r = alice.get(f"/api/runs/{run_id}").json()
    assert r["ended_at"] and "apps changed" in r["detail"]
    run2 = alice.post(f"/api/agents/{a['id']}/runs").json()["id"]
    alice.put(f"/api/agents/{a['id']}/grants", json={"grants": [{"connection_id": conn["id"], "tool_name": None}]})   # no change
    assert alice.get(f"/api/runs/{run2}").json()["ended_at"] is None


def test_awake_lists_only_your_open_runs(make_user, fake_sandbox):
    alice, bob = make_user("alice"), make_user("bob")
    a = setup_agent(alice)
    run_id = alice.post(f"/api/agents/{a['id']}/runs").json()["id"]
    assert alice.get("/api/runs/active").json() == [{"agent_id": a["id"], "run_id": run_id, "status": "starting"}]
    assert bob.get("/api/runs/active").json() == []
    alice.delete(f"/api/runs/{run_id}")
    assert alice.get("/api/runs/active").json() == []
