# Contributing to Agent Town

Thanks for helping. There are two ways in:

1. **Add an agent to the market**: share an agent you actually use. No app code needed.
2. **Improve Agent Town itself**: the API, the sandbox runner, the map, the UI.

Both go through a pull request.

---

## Adding an agent to the market

The market is the [`agents/`](agents/) folder. Everyone running Agent Town sees these agents under
**+ Add agents → Agent market** and can add one to their town with a click.

### 1. Make a folder

```
agents/
  your-agent/
    AGENT.md          the agent: frontmatter + instructions (required)
    checklist.md      anything it should know (optional, .md or .txt, sub-folders are fine)
```

The folder name is the agent's name: lowercase words joined by hyphens (`meeting-notes`,
`code-reviewer`).

### 2. Write `AGENT.md`

```markdown
---
name: your-agent
description: One line on what it does and when to use it (10–200 characters).
tags: writing, productivity
author: your-github-username
color: #3f8fd2
building: library
tools: gmail, notion
team: research-assistant, meeting-notes
ask: What's your name, and what do you do? | How do you like answers to sound?
---

# Your agent

You are … what it does, how it works step by step, what it hands back, and what it must never do.
```

| Key | Required | What it's for |
|---|---|---|
| `name` | yes | Same as the folder name. |
| `description` | yes | Shown on the market card. Say what it does and when to reach for it. |
| `tags` | yes | Comma-separated, lowercase. |
| `author` | yes | Your GitHub username (or a name you're happy to show publicly). |
| `color` | no | `#rrggbb`: its roof and its NPC's outfit on the map. |
| `building` | no | `studio`, `office`, `forge`, `library`, `lab`, `observatory`, `tavern`, `cottage` or `tower`. Picked from the description if you leave it out. |
| `tools` | no | MCP tools it works best with (`gmail`, `github`, `postgres`…). A hint for people; it still runs without them. |
| `team` | no | Other market agents it hands work to (with Claude's Task tool). Installing it installs them too. One level deep. |
| `ask` | no | Up to 5 questions shown in **Make it your own** right after someone adds it, separated by `\|`. Answers are saved to `about-me.md`, which the agent reads first. Ask what makes it useful for *them*. |

Each line of the frontmatter is `key: value` on a single line.

### 3. What makes a good market agent

[AGENTS.md](AGENTS.md#part-1-agents-for-agent-town) explains how agents run and what the platform supports; read it first.

- **Useful on its own.** Someone should get value the first time they chat with it.
- **Clear process and output.** Say how it works and what its answer looks like. A format beats a
  paragraph of adjectives.
- **Safe by default.** Anything that sends, posts, pays, deletes or changes data should draft
  and ask first. Say so in the instructions.
- **Honest.** Tell it not to invent facts, numbers, sources or results.
- **Short.** Most good agents are 30–80 lines. Put long reference material in its own file and
  tell the agent to read it ("Before writing, read `style-guide.md`").
- **Generic.** No company-specific names, internal URLs or assumptions about one person's setup.
  If it needs specifics (an FAQ, a style guide), ship a template the user replaces.

### 4. What's not allowed

- **Secrets of any kind**: API keys, tokens, passwords, private keys. Not even fake-looking real ones.
- **Personal details**: real email addresses (use `@example.com`), phone numbers, home paths
  (`/Users/you/…`), names of private people, anything from your private agents you wouldn't post
  publicly.
- **Content you don't have the right to share**: copied prompts from paid products, copyrighted
  text.
- **Agents meant to deceive or harm**: spam, impersonation, scraping people, evading security.
- Files other than `.md` / `.txt`, more than 50 files, or a file over 200,000 characters.

### 5. Check it

```bash
cd backend
uv sync
uv run pytest tests/test_marketplace.py
```

This checks every market agent: required frontmatter, the folder name, file paths and sizes, that
team members exist, and that nothing looks like a secret or personal detail. Then try it for real:
run Agent Town locally (see the [README](README.md#run-it)), open **+ Add agents**, add your agent from
the market and chat with it.

### 6. Open a pull request

- One agent per pull request (an agent and its team members count as one).
- Add a row for it to the table in [`agents/README.md`](agents/README.md).
- In the description: what you use it for, and one example conversation.

---

## Improving Agent Town itself

### Run it

See [Run it](README.md#run-it) in the README: the API is FastAPI + SQLAlchemy (`backend/`), the web
app is React + a canvas renderer (`frontend/`), and agents run in a sandbox (`backend/runner/`).
Chatting with an agent locally needs `claude` or `codex` on your PATH, or a Modal account.

### Before you open a pull request

```bash
cd backend && uv run pytest              # all tests pass
cd frontend && npm run build             # type-checks and builds
cd frontend && npx oxlint src            # no new warnings
```

- Database change? Add a migration: `cd backend && uv run alembic revision --autogenerate -m "…"`,
  read what it generated, and give new non-null columns a `server_default` so existing rows work.
- New endpoint? Every query is scoped to the signed-in user, someone else's things return 404,
  and there's a test in `tests/test_isolation.py` style that proves it.
- Anything the sandbox receives (the manifest, `/api/runtime/*`)? Keep secrets out of the manifest;
  credentials only travel through `/api/runtime/setup`.
- UI change? Check it in all three map styles and at phone width.

### Style

Match the code around you: short functions, plain names, a docstring or comment saying *why* when it
isn't obvious, no dead code. Keep pull requests focused: one change, explained in the description.

### Security

Found a vulnerability? Please don't open a public issue. Contact the maintainer privately through
GitHub (the repository's **Security** tab, or a direct message) with steps to reproduce.

---

## Ground rules

- Be kind and assume good intent. Critique code and prompts, not people.
- Never commit secrets or anyone's personal data. If you do by accident, say so right away so the
  secret can be rotated; deleting the commit isn't enough on a public repo.
- By contributing, you agree your contribution is shared under this project's [MIT License](LICENSE).

## How pull requests are merged

Every pull request runs CI (backend tests including the market checks, the frontend build and lint,
and the production image build). The maintainer reviews it and is the only one who merges into
`main`.
