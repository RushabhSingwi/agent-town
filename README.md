# Agent Town

A town of AI agents. Sign up, add your agents (markdown files, like Claude Code's
`.claude/agents/*.md`), connect your MCP servers, and choose what to share with everyone.

- **Make it your own.** Right after you add an agent (and any time from its panel): answer a few
  questions it asks about you (saved as `about-me.md`, which it reads first), tick the apps it may
  use, and check which AI account it thinks with. Map style and other extras live in the ⋯ menu.
- **Agent market.** Ready-made agents in [`agents/`](agents/) (a code reviewer, inbox triage,
  meeting notes, a chief of staff with a team, and more), one click away under **+ Add agents**.
  Anyone can add theirs: see [CONTRIBUTING.md](CONTRIBUTING.md#adding-an-agent-to-the-market).
- **Adding agents.** **+ Add agents** takes a single `.md`, a few files, or a whole folder (a
  `.claude` folder, an agents repo). Agent Town finds the agent definitions (frontmatter with
  `name:`; not skills, commands or memory notes), gives each agent the files its instructions link
  to, and puts files several agents use (or none links to) into **Shared files**. When a slash
  command shares an agent's name (`commands/lead.md` next to `agents/lead.md`), you pick which is
  the agent; the command wins by default when the agent file is only a guard. An agent whose
  instructions hand work off ("launch…", "delegate…") to other imported agents gets them as its team. You see the
  plan in plain words and confirm. Importing the same folder again updates agents by name.
- **Teams.** An agent can hand work to your other agents, like Claude Code sub-agents (About →
  Team). In its sandbox each teammate becomes a sub-agent in `.claude/agents/`, with only its own
  instructions, files (under `team/<name>/`) and tools, and the lead gets the `Task` tool. Claude
  models only for now; one level deep. On the map, selecting a lead shows trails to its team.
- **Shared files (private).** Knowledge all your agents can read, stored once: "about us", a style
  guide. In a run they sit next to the agent's own files, at the same paths.
- **The map.** A 2D game town on an island, in your choice of three looks (Retro, Blocks,
  Fantasy), all drawn in code with no image files. Winding roads branch out of a square with a
  fountain and market stalls; your agents' houses line them, a farm road leads west to your tools,
  and people's shared agents sit to the south. Ponds, woods and lamp posts fill the rest. It's
  seeded by your username, so it looks the same every visit, and grows as you add agents.
  You're a character in it: walk with W A S D or the arrows (Shift runs), or click the ground, and
  press E next to an agent to talk to it. Everyone's name floats over their head. Only you can see
  your town.
- **A living town.** Apps send couriers along the roads to the agents that use them: riders for
  Gmail and Calendar, carts for GitHub, Notion and databases, boats round the island for Slack and
  other outside apps. When an agent uses an app mid-chat, its courier sets off at once. A lantern by
  each door shows who's awake, sleeping houses puff "z z", and a working agent waits at its door.
- **Talking and visiting.** Talking to an agent opens an RPG-style dialogue box (portrait, typed-out
  replies). Its files and settings live inside its house: instructions on the desk, books on the
  shelf, what it knows about you on the noticeboard, apps in the stable, its team on the portrait
  wall, settings in the chest.
- **Agents' buildings.** Each agent is an NPC with its own building in a style that fits what it
  does (studio, forge, library, observatory, tower…, or your choice). Its size comes from its
  importance (lines it knows, plus its files and tools), its stories from its files, an annex
  shows an emblem per tool it may use, and a banner flies when it's shared publicly. NPCs wander
  their yards, walk to the door and work while a chat is busy, and show a bubble when something's wrong.
- **Your tools (MCP).** Each MCP connection is a building on the farm: mail is a
  horse stable, calendar a clock tower, GitHub a workshop, Notion an archive, Slack a signal tower,
  a database a well, anything else a barn, each with a status lamp. Select one (or an agent) to
  see trails to whoever may use it, per tool or for all of a connection's tools. Agent Town does a real MCP
  handshake and lists the server's tools.
- **Public district.** Share a whole agent or a single file (files go to the **Library**), with a
  note on what it's for. Everyone can browse it. Other people's agents can read it if the share
  allows agent use *and* their owner lets that agent read the public district.
- **Your model, your bill.** Each user adds their own Anthropic or OpenAI API key, or their
  subscription (`claude setup-token`, Codex `auth.json`), under Account → Models. It's
  encrypted and never shown again. API keys are checked with the provider's free "list models"
  call; a subscription is marked valid after its first successful run. A user's credential
  only ever runs that user's own agents. Using a subscription this way is between the user and
  their provider, and the UI says so. `AGENTTOWN_ALLOW_SUBSCRIPTION_TOKENS=false` turns them off.
- **Chat with an agent.** **Chat** on an agent starts a sandbox for it, with its files, its
  granted tools and its owner's credential, and runs Claude Code (Anthropic) or Codex (OpenAI)
  inside. See [Runs](#runs-an-agent-in-its-own-sandbox).
- **Manifest.** `GET /api/agents/{id}/manifest` is everything an agent is handed when it runs:
  instructions, files, granted tools, and the public items it may read. The sandbox starts from
  exactly this. No credentials are in it.

## Run it

```bash
# API: http://127.0.0.1:8000  (interactive docs at /docs)
cd backend
cp .env.example .env
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload

# Web: http://localhost:5173  (forwards /api to the API)
cd frontend
npm install
npm run dev

# Optional: a tiny MCP server to connect to, at http://127.0.0.1:8765/mcp
cd backend && uv run uvicorn dev.demo_mcp_server:app --port 8765
```

Chatting with an agent locally needs `claude` (Claude Code) or `codex` on your PATH, since the
local sandbox runs them as a subprocess.

Tests: `cd backend && uv run pytest`. They cover auth (sessions and API tokens: revoked,
expired, can't escalate), one user being unable to reach another's town on any endpoint,
model credentials (never returned, owner-only), sharing, grants, the manifest, the MCP
handshake (JSON and SSE replies), credential prompts, the SSRF guard, and runs (run tokens,
privacy, reuse, provider failures, reaping a dead sandbox).

## Connecting Gmail and Google Calendar

Agent Town signs people in with Google (OAuth 2.0 with PKCE), keeps their tokens encrypted on the
server, and serves the Gmail and Calendar tools itself (`/api/runtime/mcp/{id}`), so the Google token
never enters a sandbox. Agents can search and read mail and write **drafts** (never send), and list and
add calendar events (without inviting anyone). Code: `app/google.py`, `routers/connect.py`,
`routers/hosted.py`.

Each server needs its own Google OAuth client:

1. In [Google Cloud](https://console.cloud.google.com), create a project and enable the **Gmail API**
   and the **Google Calendar API**.
2. **Google Auth Platform:** set up the app (External), add the scopes `gmail.readonly`,
   `gmail.compose`, `calendar.events`, and add yourself under **Audience → Test users**.
3. **Clients → Create client → Web application**, with the redirect URI
   `<AGENTTOWN_APP_URL>/api/connect/google/callback`. Locally that's
   `http://127.0.0.1:8000/api/connect/google/callback`, and you open the app at http://127.0.0.1:8000.
4. Download the client's JSON and import it without printing the secret:
   `cd backend && uv run python scripts/import_google_client.py ~/Downloads/client_secret_….json`.
   On Render, set `AGENTTOWN_GOOGLE_CLIENT_ID` and `AGENTTOWN_GOOGLE_CLIENT_SECRET` instead.

In Google's **Testing** mode only your test users can connect, they see an "unverified app" warning,
and sign-ins expire after 7 days. For the public, Google must verify the app, and Gmail's scopes also
need a yearly security assessment.

## Deploy (Render + Modal)

Production is one process: the `Dockerfile` builds the frontend, and the API serves
`frontend/dist` itself. Agents don't run on that server; each chat gets its own Modal Sandbox.

1. Make a Modal account and an API token (modal.com → Settings → API tokens).
2. Render Dashboard → **New → Blueprint** → this repo. `render.yaml` creates:
   - `agenttown`: the web service (Docker), with `alembic upgrade head` before each deploy
   - `agenttown-db`: Postgres, wired in as `AGENTTOWN_DATABASE_URL`
   - `AGENTTOWN_SECRET_KEY`, generated once by Render. If it ever changes, every stored
     credential becomes unreadable.
3. Paste `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` when Render asks for them. No secrets live in
   this repo: they're generated by Render or entered in its dashboard.
4. The first chat builds the sandbox image on Modal (a few minutes); later ones reuse it.
5. Optional: add `AGENTTOWN_GOOGLE_CLIENT_ID` and `AGENTTOWN_GOOGLE_CLIENT_SECRET` (see Connecting Gmail
   above) and register `https://<your-app>.onrender.com/api/connect/google/callback` on the client.

Sandboxes call back to the API at `RENDER_EXTERNAL_URL` (the `onrender.com` address). With a
custom domain, set `AGENTTOWN_PUBLIC_URL` to it. Check the Blueprint with `render blueprints validate`.

## How it works

```
frontend/src
  api.ts             typed fetch calls; the cookie goes along automatically (same origin)
  city/layout.ts     city data -> the island: roads, houses, paths, ponds, woods (pure, seeded)
  city/kinds.ts      which building an agent or a tool gets
  city/themes.ts     the three looks' palettes; city/sprites.ts draws buildings, trees and NPCs
  city/render.ts     the game loop: cached ground and buildings, walking NPCs, picking, pan and zoom
  App.tsx, cards.tsx, modals.tsx   the React UI around the canvas

backend/app
  models.py          the tables (diagram at the top of the file)
  auth.py            session cookie -> user
  security.py        argon2 password hashes, session/API tokens, encryption of MCP and model credentials
  model_check.py     is a model key real? (the provider's free "list models" call)
  routers/account.py API tokens and model credentials
  mcp_client.py      MCP over Streamable HTTP by hand: initialize -> initialized -> tools/list
  manifest.py        what an agent gets at runtime
  importer.py        a dropped folder -> agents, their files, and shared files (pure functions)
  sandbox.py         where a run's box comes from: local subprocess (dev) or Modal
  routers/files.py   shared files, import (preview, then import), and the agent market
  marketplace.py     reads agents/ (the market) and checks contributions
  routers/runs.py    start/stop a run, chat messages, and the sandbox-facing /api/runtime
  routers/           auth, agents, mcp, public
  main.py            app, CSRF guard, /api/city, serves the built frontend
backend/runner/runner.py   runs inside the sandbox (stdlib only): setup, then Claude Code or Codex per turn
agents/              the agent market: one folder per agent (see CONTRIBUTING.md)
backend/alembic      migrations (uv run alembic revision --autogenerate -m "...")
backend/dev/demo_mcp_server.py   a hand-written MCP server, so you can see the server side too
```

### Auth, and why it's built this way
No endpoint takes a user id from the client. Every request is matched to a user on the
server, from one of two credentials:

| Who | How | Stored as |
|---|---|---|
| Browsers | session cookie set at login | sha256 of the token |
| Programs (CLI, scripts, the sandbox later) | `Authorization: Bearer at_…` from Account → API tokens | sha256 of the token |

```bash
curl -H "Authorization: Bearer at_…" http://127.0.0.1:8000/api/city   # your town, nobody else's
```

- **API tokens:** shown once, optionally expire, and record when they were last used. They
  can't create tokens or read model keys; only a browser session can, so a leaked token
  can't spread.
- **Bad tokens:** a bad or expired token gets a `401` (not "signed out"), so scripts fail loudly.
- **Isolation tests:** `tests/test_isolation.py` has a second user try every endpoint against
  the first user's agents, files, connections, tokens and keys, with a session and with a
  token. Every attempt gets 404.

- **Passwords:** argon2id (`argon2-cffi`). Login is equally slow for unknown emails and
  wrong passwords, so the timing doesn't reveal which emails have accounts.
- **Sessions:** a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie. The database
  stores only its SHA-256, so a leaked database can't be used as cookies. Logging out
  deletes the row.
- **CSRF:** `SameSite=Lax` stops other sites from sending the cookie on POSTs. On top of
  that, any write whose `Origin` is a different site gets a 403.
- **Authorization:** every query for agents, connections and shares is scoped by owner.
  Someone else's private agent returns 404, not 403, so its existence doesn't leak.

### MCP connections
- **HTTP servers** are checked from the API server. This is SSRF territory: the URL is
  user-supplied, so private, loopback and link-local addresses are refused unless
  `AGENTTOWN_ALLOW_PRIVATE_MCP_HOSTS=true` (local dev only).
- **Credentials:** an `Authorization` header can be stored. It's encrypted with Fernet, keyed
  from `AGENTTOWN_SECRET_KEY`, and never returned by the API.
- **stdio servers** (e.g. `npx @gongrzhe/server-gmail-autoauth-mcp`) can't run on the web
  server. They show as *runs in sandbox* until the sandbox exists.

## Runs: an agent in its own sandbox

```
browser            API (control plane)                      sandbox (one per run)
  Chat ──POST /api/agents/{id}/runs──► Run row + run token ──► provider.start()
       ◄── 202 {status: starting}                               runner.py:
                                       GET /api/runtime/setup ◄── manifest + the owner's credential
                                                                  write files, MCP config
                                       POST /runtime/events   ◄── status: ready
  send ──POST /api/runs/{id}/messages─► user event
                                       GET /runtime/inbox     ◄── polls every second (and that's its heartbeat)
                                                                  claude -p … / codex exec … (resumes the conversation)
                                       POST /runtime/events   ◄── text, tool, tool_result, done
  poll ──GET /api/runs/{id}/events────► everything after the cursor
```

- **The sandbox only calls out.** It needs no public address, so every provider works the same.
- **Run token** (`rt_…`): made per run, stored as a hash, works only on `/api/runtime/*` for that
  run, and stops working the moment the run ends. It can't touch `/api/agents` and an API token
  can't touch `/api/runtime`.
- **Credentials** leave the server only in `/api/runtime/setup`, to that run's own box. The CLI gets
  them as `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `CODEX_API_KEY` or a written `auth.json`.
  The run token is removed from the CLI's environment.
- **Tools:** Claude Code runs with `--permission-mode dontAsk`, file tools in its working directory
  (plus Bash in a real sandbox) and exactly the granted MCP tools (`--allowedTools mcp__server__tool`).
  Codex gets the same servers with `enabled_tools`.
- **Lifecycle:** opening Chat again reuses a running sandbox. The runner exits after
  `AGENTTOWN_RUN_IDLE_MINUTES` without messages; the API marks a box that stops polling as failed,
  and nothing lives past `AGENTTOWN_RUN_MAX_HOURS` (Modal enforces it too).
- **Providers** (`AGENTTOWN_SANDBOX_PROVIDER`):
  - `local`: a subprocess in a temp directory with a clean environment. **Not isolated**, so no Bash
    for Claude (Codex keeps its own OS sandbox). For development.
  - `modal`: a Modal Sandbox per run, from an image with Node, Claude Code and Codex. `uv sync --group modal`,
    then set `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` and `AGENTTOWN_PUBLIC_URL` (the box must reach the API).
    The first run builds the image (minutes); Modal caches it after that.

Not done yet: an egress allowlist (today a sandbox can reach the internet, e.g. for `npx` stdio
servers), a warm pool for instant starts, streaming instead of polling, and the common area.

Known gaps worth doing before real users: OAuth for remote MCP servers (most hosted ones want
it, rather than a pasted header), email verification and password reset, rate limits on login,
and Postgres in CI.

## License and policies

[MIT](LICENSE). Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
Writing agents for Agent Town (or an AI reading this repo)? See [AGENTS.md](AGENTS.md).
What's next: [ROADMAP.md](ROADMAP.md).
The hosted service's [privacy policy](PRIVACY.md).
