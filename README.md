# Agent Town

A town of AI agents. Sign up, add your agents (markdown files, like Claude Code's
`.claude/agents/*.md`), connect your MCP servers, and choose what to share with everyone.

- **Your district (private).** Each agent is a building: one floor per file, the biggest at
  the bottom. A floor's height comes from its line count, and the footprint grows with the
  number of files. Only you can see it.
- **Utilities (MCP).** Each MCP connection is a station with a status lamp: connected,
  needs credentials, error, or runs in sandbox. Agent Town does a real MCP handshake and
  lists the server's tools. Wires run from a station to every agent allowed to use it,
  per tool or for all of a connection's tools.
- **Public district.** Share a whole agent or a single file (files go to the **Library**), with a
  note on what it's for. Everyone can browse it. Other people's agents can read it if the share
  allows agent use *and* their owner lets that agent read the public district.
- **Manifest.** `GET /api/agents/{id}/manifest` is everything an agent is handed when it runs:
  instructions, files, granted tools, and the public items it may read. A sandbox provider
  (Modal, next) starts from exactly this. No credentials are in it.

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

Tests: `cd backend && uv run pytest`. They cover auth, privacy, sharing, grants, the
manifest, the MCP handshake (JSON and SSE replies), credential prompts and the SSRF guard.

Production is one process: `cd frontend && npm run build`, then the API serves
`frontend/dist` itself. Use Postgres via `AGENTTOWN_DATABASE_URL`, a real
`AGENTTOWN_SECRET_KEY`, and `AGENTTOWN_COOKIE_SECURE=true` behind HTTPS.

## How it works

```
frontend/src
  api.ts             typed fetch calls; the cookie goes along automatically (same origin)
  city/layout.ts     city data -> where every building, station and wire goes (pure function)
  city/render.ts     draws the layout isometrically on a canvas, and says what's under the pointer
  App.tsx, cards.tsx, modals.tsx   the React UI around the canvas

backend/app
  models.py          the tables (diagram at the top of the file)
  auth.py            session cookie -> user
  security.py        argon2 password hashes, session tokens, encryption of MCP credentials
  mcp_client.py      MCP over Streamable HTTP by hand: initialize -> initialized -> tools/list
  manifest.py        what an agent gets at runtime
  routers/           auth, agents, mcp, public
  main.py            app, CSRF guard, /api/city, serves the built frontend
backend/alembic      migrations (uv run alembic revision --autogenerate -m "...")
backend/dev/demo_mcp_server.py   a hand-written MCP server, so you can see the server side too
```

### Auth, and why it's built this way
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

## Next: the sandbox (Modal)
1. `POST /api/agents/{id}/runs`: create a run, then start a Modal Sandbox with the manifest.
2. In the sandbox, write `files/`, start the stdio MCP servers, and connect the HTTP ones. A
   short-lived run token lets the sandbox fetch decrypted credentials per connection.
3. Run the agent loop (Claude Agent SDK or `codex exec`) with only the granted tools.
4. Stream events back (tool calls, file reads), so the city can show the agent walking.
5. Egress allowlist: the sandbox may reach the model API and the granted MCP hosts only.

Known gaps worth doing before real users: OAuth for remote MCP servers (most hosted ones want
it, rather than a pasted header), email verification and password reset, rate limits on login,
and Postgres in CI.
