"""Runs inside the sandbox. Standard library only, so any image with Python can run it.

    AGENTTOWN_API_URL, AGENTTOWN_RUN_TOKEN  set by the provider (app/sandbox.py)

1. GET  /api/runtime/setup     the manifest, the owner's model credential, MCP auth headers
2. write the agent's files, configure its MCP servers, pick the engine:
     anthropic -> Claude Code (`claude -p`), api key or `setup-token` subscription
     openai    -> Codex (`codex exec`), api key or ChatGPT auth.json
3. loop: GET /api/runtime/inbox for the owner's messages; for each one run a turn of the CLI,
   resuming the same conversation, and POST /api/runtime/events with what the agent says and does
4. after each turn, if the agent changed its notes, PUT /api/runtime/memory so its next chat has them;
   between turns, pick up the owner's edits to them (the inbox says when they changed)
5. exit when the owner has been quiet for AGENTTOWN_IDLE_MINUTES, or the API says the run ended

Each turn is a fresh CLI process that resumes the conversation by id: simple, and a crash in
one turn can't wedge the next.
"""

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ["AGENTTOWN_API_URL"].rstrip("/")
TOKEN = os.environ["AGENTTOWN_RUN_TOKEN"]
ALLOW_SHELL = os.environ.get("AGENTTOWN_ALLOW_SHELL") == "1"
IDLE = int(os.environ.get("AGENTTOWN_IDLE_MINUTES", "15")) * 60
ROOT = Path.cwd()
WORK = ROOT / "work"          # the agent's working directory: its files, and public/ items
HOME = Path(os.environ.get("HOME", ROOT / "home"))
CLIP = 4000                   # how much of a tool's output goes back to the UI
# What it remembers. Agent file paths can't start with ".", so nothing it was given can clash with these.
MEMORY, RECENT = ".agent-town/memory.md", ".agent-town/recent-chats.md"


class Ended(Exception):
    pass


def api(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise Ended("the run ended") from e
        raise


def emit(kind: str, **data) -> None:
    api("POST", "/api/runtime/events", {"events": [{"kind": kind, "data": data}]})


def clip(v) -> str:
    s = v if isinstance(v, str) else json.dumps(v)
    return s if len(s) <= CLIP else s[:CLIP] + f"… ({len(s) - CLIP} more characters)"


def server_name(name: str) -> str:
    """Lowercase, like the names people give MCP servers in Claude Code: "Gmail" -> mcp__gmail__…"""
    return re.sub(r"[^a-z0-9_-]+", "_", name.lower()).strip("_") or "server"


def write_files(m: dict) -> list[str]:
    """Shared files first, then the agent's own (which win on a clash), then public items.
    Returns the paths written, so the agent can be told what it has."""
    WORK.mkdir(parents=True, exist_ok=True)
    out = [(f["path"], f["content"]) for f in m.get("shared", [])]
    out += [(f["path"], f["content"]) for f in m["files"] if f["path"] != "AGENT.md"]
    for p in m["public"]:
        files = [p["file"]] if p.get("file") else (p.get("agent") or {}).get("files", [])
        for f in files:
            out.append((f"public/{p['owner']}/{server_name(p['title'])}/{f['path']}", f.get("content", "")))
    written = []
    for rel, content in out:
        dest = (WORK / rel).resolve()
        if WORK.resolve() not in dest.parents:
            continue  # paths are validated by the API; this is belt and braces
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content)
        if rel not in written:
            written.append(rel)
    return written


def write_team(m: dict) -> list[dict]:
    """Each teammate's files go under team/<slug>/, so they never mix with the lead's."""
    out = []
    for t in m.get("team", []):
        base = WORK / "team" / t["slug"]
        paths = []
        for f in t["files"]:
            dest = (base / f["path"]).resolve()
            if base.resolve() not in dest.parents:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(f["content"])
            paths.append(f"team/{t['slug']}/{f['path']}")
        out.append({**t, "paths": paths})
    return out


def write_recent(m: dict) -> None:
    """Its last few chats, words only, newest first."""
    chats = m.get("recent_chats") or []
    if not chats:
        return
    out = ["# Your recent chats", "", "Newest first: what was said, not what you did. Read-only; keep anything"
           f" worth remembering in {MEMORY}.", ""]
    for c in chats:
        out += [f"## {c['started_at'][:16].replace('T', ' ')} UTC", ""]
        if c.get("cut"):
            out += ["(earlier messages in this chat left out)", ""]
        out += [f"**{'They' if x['who'] == 'owner' else 'You'}:** {x['text']}\n" for x in c["messages"]]
    (WORK / RECENT).parent.mkdir(parents=True, exist_ok=True)
    (WORK / RECENT).write_text("\n".join(out))


def tag(text: str) -> str:
    """The same fingerprint the API uses (routers/runs.py memory_tag)."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


class Memory:
    """Its notes file, kept in step with the server. The owner may edit the notes mid-chat (the
    Diary): between turns that edit is copied in, and a save that started from older notes is
    refused, so the owner's version always wins and the agent is told to look again."""

    def __init__(self, notes: str):
        self.file = WORK / MEMORY
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.note = ""                  # said to the agent with the next message, then cleared
        self._take(notes)

    def _take(self, notes: str) -> None:
        self.saved = notes
        self.file.write_text(notes)

    def _reload(self, why: str) -> None:
        self._take(api("GET", "/api/runtime/memory")["content"])
        self.note = why

    def check(self, server_tag: str | None) -> None:
        """Between turns: did the owner change the notes?"""
        if server_tag and server_tag != tag(self.saved):
            self._reload(f"(The person you work for edited {MEMORY} since you last read it. Read it again before relying on it.)")

    def save(self) -> None:
        """After a turn: send the notes back if the agent changed them."""
        try:
            notes = self.file.read_text()
        except (OSError, UnicodeDecodeError):
            return              # deleted or garbled: keep what was saved rather than wipe it
        if notes == self.saved:
            return
        try:
            api("PUT", "/api/runtime/memory", {"content": notes, "base": tag(self.saved)})
        except urllib.error.HTTPError as e:
            if e.code == 409:
                self._reload(f"(The person you work for edited {MEMORY} while you were working, so the changes you"
                             " made to it weren't kept. Read it again and redo any that still matter.)")
                return
            if e.code != 422:
                raise
            emit("error", detail=f"{MEMORY} is over 20,000 characters, so this version wasn't kept. Ask it to shorten its notes.")
            return
        self.saved = notes

    def tell(self, text: str) -> str:
        """The owner's message, with anything the agent should know about its notes first."""
        note, self.note = self.note, ""
        return f"{note}\n\n{text}" if note else text


def system_prompt(m: dict, files: list[str]) -> str:
    """The agent's own instructions, plus where its files are. Instructions written for another
    setup may link `../../content/a.md`; the list lets it find content/a.md here."""
    extra = "\n\n---\nYour files are in the current directory."
    if "about-me.md" in files:
        extra += " about-me.md is what the person you work for told you about themselves: read it first and use it."
    if files:
        shown = files[:200]
        extra += " Read the ones your instructions mention before you start:\n" + "\n".join(f"- {f}" for f in shown)
        if len(files) > len(shown):
            extra += f"\n- … and {len(files) - len(shown)} more"
    if m["public"]:
        extra += "\nThings other people shared for agents to read are under public/<owner>/."
    if m.get("team"):
        extra += ("\n\nYour team (hand work to them with the Task tool; each has its own files and tools):\n"
                  + "\n".join(f"- {t['slug']}: {t['description'] or t['name']}" for t in m["team"]))
    extra += (f"\n\nYou don't remember past chats on your own, so you have two files for it. Read both before you"
              f" start.\n- {MEMORY}: your notes, kept between chats (only this file is kept). When you learn"
              " something worth knowing next time (their preferences, decisions made, work still open, what to"
              " follow up on), update it before you answer. Keep it short and current: rewrite it rather than"
              " append, under 20,000 characters, and never put passwords or keys in it.")
    if m.get("recent_chats"):
        extra += f"\n- {RECENT}: what was said in your last few chats, newest first."
    return m["instructions"] + extra


def servers(m: dict, auth_headers: dict, tools: list[dict] | None = None) -> list[dict]:
    """The MCP servers this agent was granted, and which of their tools (None: all of them)."""
    out = []
    for t in m["tools"] if tools is None else tools:
        if not t["usable"]:
            continue
        # hosted (Gmail, Calendar): Agent Town serves those tools itself; this run's token gets in
        auth = f"Bearer {TOKEN}" if t.get("hosted") else auth_headers.get(str(t["connection_id"]))
        s = {"name": server_name(t.get("server") or t["connection"]), "transport": t["transport"], "url": t["url"],
             "command": t["command"], "auth": auth,
             "tools": None if t["all_tools"] else [x["name"] for x in t["tools"]]}
        out.append(s)
    return out


def stream(cmd: list[str], prompt: str, env: dict, on_line) -> tuple[int, str]:
    """Run one turn of a CLI, handing each JSON line of its output to on_line as it arrives."""
    p = subprocess.Popen(cmd, cwd=WORK, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True)
    p.stdin.write(prompt)
    p.stdin.close()
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        on_line(msg)
    err = p.stderr.read()
    return p.wait(), err[-2000:]


class Claude:
    """Claude Code in print mode. Tools: file tools in the working directory (plus Bash in a real
    sandbox) and exactly the granted MCP tools. dontAsk mode refuses anything not allowed."""

    def __init__(self, m: dict, cred: dict, auth_headers: dict, files: list[str], team: list[dict] | None = None):
        self.model, self.effort = cred["model"], cred.get("thinking") or ""
        self.session, self.system = None, system_prompt(m, files)
        self.env = {**os.environ}
        for k in ("AGENTTOWN_RUN_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"):
            self.env.pop(k, None)
        self.env["ANTHROPIC_API_KEY" if cred["kind"] == "api_key" else "CLAUDE_CODE_OAUTH_TOKEN"] = cred["secret"]
        builtin = ["Read", "Write", "Edit", "Glob", "Grep"] + (["Bash"] if ALLOW_SHELL else [])
        self.tools, allowed, config = list(builtin), list(builtin), {}

        def add(srv: list[dict]) -> list[str]:
            names = []
            for s in srv:
                if s["name"] not in config:
                    if s["transport"] == "http":
                        config[s["name"]] = {"type": "http", "url": s["url"],
                                             **({"headers": {"Authorization": s["auth"]}} if s["auth"] else {})}
                    else:
                        argv = shlex.split(s["command"] or "")
                        config[s["name"]] = {"type": "stdio", "command": argv[0], "args": argv[1:]}
                names += [f"mcp__{s['name']}"] if s["tools"] is None else [f"mcp__{s['name']}__{t}" for t in s["tools"]]
            return names

        allowed += add(servers(m, auth_headers))
        if team:                                   # teammates become Claude Code sub-agents in .claude/agents/
            self.tools.append("Task"); allowed.append("Task")
            agents_dir = WORK / ".claude" / "agents"
            agents_dir.mkdir(parents=True, exist_ok=True)
            for t in team:
                own = add(servers(m, auth_headers, t["tools"]))
                allowed += own
                desc = (t["description"] or t["name"]).replace("\n", " ")
                body = t["instructions"] + ("\n\nYour files are in team/" + t["slug"] + "/:\n" + "\n".join(f"- {p}" for p in t["paths"]) if t["paths"] else "")
                (agents_dir / f"{t['slug']}.md").write_text(
                    f"---\nname: {t['slug']}\ndescription: {json.dumps(desc)}\ntools: {', '.join(builtin + own)}\n---\n\n{body}\n")
        self.allowed = list(dict.fromkeys(allowed))
        self.mcp = HOME / "mcp.json"
        self.mcp.write_text(json.dumps({"mcpServers": config}))

    def turn(self, text: str) -> None:
        cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
               f"--tools={','.join(self.tools)}", f"--allowedTools={','.join(self.allowed)}",
               "--strict-mcp-config", "--mcp-config", str(self.mcp), "--append-system-prompt", self.system]
        if self.model:
            cmd += ["--model", self.model]
        if self.effort:
            cmd += ["--effort", self.effort]
        if self.session:
            cmd += ["--resume", self.session]
        finished = False

        def on_line(msg: dict) -> None:
            nonlocal finished
            t = msg.get("type")
            if msg.get("session_id"):
                self.session = msg["session_id"]
            if t == "assistant" and (msg.get("message") or {}).get("model") != "<synthetic>":  # synthetic: an error, reported below
                for b in (msg.get("message") or {}).get("content") or []:
                    if b.get("type") == "text" and b.get("text", "").strip():
                        emit("text", text=b["text"])
                    elif b.get("type") == "tool_use":
                        emit("tool", name=b.get("name", ""), input=clip(b.get("input")))
            elif t == "user":
                for b in (msg.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        c = b.get("content")
                        if isinstance(c, list):
                            c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
                        emit("tool_result", output=clip(c or ""), is_error=bool(b.get("is_error")))
            elif t == "result":
                finished = True
                ok = not msg.get("is_error")
                if not ok:
                    emit("error", detail=clip(msg.get("result") or msg.get("subtype") or "The turn failed"))
                emit("done", ok=ok, cost_usd=msg.get("total_cost_usd"), duration_ms=msg.get("duration_ms"),
                     turns=msg.get("num_turns"), auth_failed=msg.get("api_error_status") in (401, 403))

        code, err = stream(cmd, text, self.env, on_line)
        if not finished:
            emit("error", detail=f"claude exited with {code}: {err or 'no output'}")
            emit("done", ok=False)


def toml_str(s: str) -> str:
    return json.dumps(s)  # a JSON string is a valid TOML basic string


class Codex:
    """Codex in exec mode, configured through its own CODEX_HOME so nothing else is read."""

    def __init__(self, m: dict, cred: dict, auth_headers: dict, files: list[str]):
        self.model, self.thread = cred["model"], None
        codex_home = HOME / ".codex"
        codex_home.mkdir(parents=True, exist_ok=True)
        self.env = {**os.environ, "CODEX_HOME": str(codex_home)}
        for k in ("AGENTTOWN_RUN_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"):
            self.env.pop(k, None)
        if cred["kind"] == "api_key":
            self.env["CODEX_API_KEY"] = cred["secret"]
        else:
            (codex_home / "auth.json").write_text(cred["secret"])
            (codex_home / "auth.json").chmod(0o600)
        lines = []
        for s in servers(m, auth_headers):
            lines.append(f"[mcp_servers.{s['name']}]")
            if s["transport"] == "http":
                lines.append(f"url = {toml_str(s['url'])}")
                if s["auth"]:
                    lines.append(f"http_headers = {{ Authorization = {toml_str(s['auth'])} }}")
            else:
                argv = shlex.split(s["command"] or "")
                lines.append(f"command = {toml_str(argv[0])}")
                lines.append(f"args = [{', '.join(toml_str(a) for a in argv[1:])}]")
            if s["tools"] is not None:
                lines.append(f"enabled_tools = [{', '.join(toml_str(t) for t in s['tools'])}]")
        (codex_home / "config.toml").write_text("\n".join(lines) + "\n")
        # In a real sandbox the container is the boundary; locally, Codex's own sandbox is.
        mode = "danger-full-access" if ALLOW_SHELL else "workspace-write"
        self.common = ["--json", "--skip-git-repo-check", "-c", f"sandbox_mode={toml_str(mode)}",
                       "-c", 'approval_policy="never"', "-c", f"developer_instructions={toml_str(system_prompt(m, files))}"]
        if self.model:
            self.common += ["-m", self.model]
        effort = {"max": "xhigh"}.get(cred.get("thinking") or "", cred.get("thinking") or "")
        if effort:
            self.common += ["-c", f"model_reasoning_effort={toml_str(effort)}"]

    def turn(self, text: str) -> None:
        cmd = ["codex", "exec", "resume", self.thread, *self.common, "-"] if self.thread else \
              ["codex", "exec", *self.common, "-"]
        finished = False

        def on_line(msg: dict) -> None:
            nonlocal finished
            t = msg.get("type")
            if t == "thread.started":
                self.thread = msg.get("thread_id") or self.thread
            elif t == "item.started":
                it = msg.get("item") or {}
                if it.get("type") == "mcp_tool_call":
                    emit("tool", name=f"{it.get('server')}.{it.get('tool')}", input=clip(it.get("arguments")))
                elif it.get("type") == "command_execution":
                    emit("tool", name="shell", input=clip(it.get("command", "")))
            elif t == "item.completed":
                it = msg.get("item") or {}
                kind = it.get("type")
                if kind == "agent_message" and it.get("text", "").strip():
                    emit("text", text=it["text"])
                elif kind == "mcp_tool_call":
                    emit("tool_result", output=clip(it.get("result") or it.get("error") or ""),
                         is_error=it.get("status") == "failed")
                elif kind == "command_execution":
                    emit("tool_result", output=clip(it.get("aggregated_output", "")), is_error=it.get("exit_code") not in (0, None))
                elif kind == "file_change":
                    emit("tool", name="edit", input=clip(it.get("changes")))
            elif t == "turn.completed":
                finished = True
                emit("done", ok=True, usage=msg.get("usage"))
            elif t == "turn.failed":  # plain "error" events are retries ("Reconnecting... 2/5"); this one is final
                finished = True
                detail = (msg.get("error") or {}).get("message") or "The turn failed"
                emit("error", detail=clip(detail))
                emit("done", ok=False, auth_failed="401 Unauthorized" in detail)

        code, err = stream(cmd, text, self.env, on_line)
        if not finished:
            emit("error", detail=f"codex exited with {code}: {err or 'no output'}")
            emit("done", ok=False)


def main() -> None:
    setup = api("GET", "/api/runtime/setup")
    m, cred = setup["manifest"], setup["credential"]
    HOME.mkdir(parents=True, exist_ok=True)
    files = write_files(m)
    team = write_team(m)
    write_recent(m)
    memory = Memory(m.get("memory") or "")
    if cred["provider"] == "anthropic":
        engine = Claude(m, cred, setup["auth_headers"], files, team)
    else:
        engine = Codex({**m, "team": []}, cred, setup["auth_headers"], files)
        if team:
            emit("error", detail="Teams need a Claude model for now: this agent runs on Codex, so it works alone.")
    emit("status", status="ready", detail=f"{m['agent']['name']} is ready")
    cursor, last_turn = 0, time.monotonic()
    while True:
        box = api("GET", f"/api/runtime/inbox?after={cursor}")
        memory.check(box.get("memory"))
        for msg in box["messages"]:
            cursor = msg["id"]
            emit("status", status="busy")
            try:
                engine.turn(memory.tell(msg["text"]))
            except Ended:
                raise
            except Exception as e:  # noqa: BLE001  (one bad turn shouldn't end the run)
                emit("error", detail=f"{type(e).__name__}: {e}")
                emit("done", ok=False)
            memory.save()
            emit("status", status="ready")
            last_turn = time.monotonic()
        if not box["messages"]:
            # quiet since the owner's last message, and since the agent's last answer
            if box["idle_seconds"] > IDLE and time.monotonic() - last_turn > IDLE:
                emit("status", status="stopped", detail="Stopped after being idle")
                return
            time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except Ended:
        pass
    except Exception as e:  # noqa: BLE001
        try:
            emit("status", status="error", detail=f"runner: {type(e).__name__}: {e}")
        except Exception:  # noqa: BLE001
            pass
        print(f"runner failed: {e}", file=sys.stderr)
        sys.exit(1)
