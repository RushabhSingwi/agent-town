# AGENTS.md

Guidance for AI agents (Claude Code, Codex, Cursor and others) reading this repository.

- **Writing an agent for Agent Town** (for a user, or for the market): read [Part 1](#part-1-agents-for-agent-town).
- **Changing Agent Town's code**: read [Part 2](#part-2-working-on-this-codebase).

---

## Part 1: Agents for Agent Town

Agent Town is a place where people keep their personal AI agents. Each agent is a character in a
little town, with its own house, files and chat. People chat with an agent; for each chat it wakes up
in its own private sandbox, does the work, and goes back to sleep.

### What an agent is

A folder of markdown:

```
my-agent/
  AGENT.md        frontmatter + instructions (required)
  *.md, *.txt     what it knows: playbooks, checklists, examples, templates (optional, sub-folders fine)
```

`AGENT.md` follows the Claude Code agent format, with a few extra keys for the market:

```markdown
---
name: my-agent                      # lowercase-with-hyphens; for the market, same as the folder
description: One line on what it does and when to use it.
tags: writing, productivity         # market only
author: github-username             # market only
color: #3f8fd2                      # optional: its roof and its character's outfit
building: library                   # optional: studio office forge library lab observatory tavern cottage tower
tools: gmail, github                # optional: apps it works best with (a suggestion; access is granted in the app)
team: research-assistant            # optional: other agents it hands work to
ask: What's your name? | What do you work on?   # optional: questions for "Make it your own"
---

# My agent

Instructions…
```

Claude Code's own `tools:` field (a list like `Read, Grep`) and `model:` are **ignored**: in Agent Town,
what an agent may use, and which model it thinks with and how hard (its "brain"), are chosen by its
owner in the app.

### How an agent runs

Knowing this lets you write instructions that work:

- **The engine.** It runs on its owner's own AI account: **Claude Code** for Anthropic accounts, or
  **Codex** for OpenAI accounts, by API key or subscription. The body of `AGENT.md` becomes its
  system prompt.
- **Its working directory** holds, at the same paths as in the folder:
  - its own files;
  - the owner's **shared files** (knowledge all their agents read);
  - **`about-me.md`**: the owner's answers to its `ask:` questions;
  - **`public/<owner>/…`**: things other people shared, if the owner allows it;
  - **`team/<name>/…`**: each teammate's files.

  The prompt also lists these files. Tell the agent which ones to read ("Before writing, read
  `style-guide.md`").
- **Its tools:**
  - reading, writing and searching files in its working directory;
  - a shell, **only in the cloud sandbox**;
  - the **apps its owner allowed** (MCP tools: GitHub, a database, and so on);
  - the **Task** tool to hand work to its team: Claude only, one level deep (a teammate can't have
    its own team).
- **Each chat is one run.** The conversation continues across messages until the chat ends: when the
  owner ends it, after 15 minutes of silence, or after 4 hours at most.
- **It remembers through two files** in `.agent-town/`, both described in its prompt (no agent file
  can clash with them, since file paths can't start with `.`):
  - **`.agent-town/memory.md`**: its own notes. Whatever it writes there is saved after each turn and
    handed to its next chat (20,000 characters at most). Its owner can read, edit or wipe it (the
    Diary in its house), even mid-chat: the owner's edit wins, and the agent is told to re-read it.
    It is never shared.
  - **`.agent-town/recent-chats.md`**: what was said in its last few chats (words only, newest
    first). Read-only.

  Agent Town tells every agent this already, so you don't need to. If your agent has things it
  should always note down (a client's preferences, open tasks), say so.
- **Nothing else it writes is kept** after the chat ends. Its files, shared files and `about-me.md`
  are written fresh into each run. Reference knowledge belongs in its files.

### What it supports

| Supported | Not yet |
|---|---|
| Chat-driven work: someone asks, it works, it answers | Scheduled or background jobs ("every morning…") |
| Drafting, reviewing, summarizing, planning, research, analysis | Reacting to events (new email, a webhook) |
| Using files it was given: playbooks, FAQs, checklists, examples | Saving files between chats (other than its notes) |
| Remembering: its own notes, and its last few chats | Searching all of its past chats |
| Apps its owner connected and allowed (MCP over HTTP, or a command run in the sandbox) | Notion, Slack, Linear sign-in (coming); browsers or desktop apps |
| Gmail (search, read, **draft** — never send) and Google Calendar (list, add events, no invites), on servers with a Google client | Sending email or calendar invitations on its own |
| A team: a lead handing work to other agents (Claude) | Teams more than one level deep; teams on Codex |
| Markdown and text files, up to 200,000 characters each, 50 per agent | Images, PDFs, spreadsheets as knowledge files |

If a job needs something in the right-hand column, design the agent to **draft and hand back**
instead: for example "write the email" rather than "send it every morning".

### What makes a good Agent Town agent

1. **One clear job.** Name and description say what it's for, so someone can pick it from the market
   in a glance.
2. **A process and an output format.** Steps it follows and what its answer looks like. A template
   beats adjectives.
3. **Uses what it's given.** It reads `about-me.md` and its files before working, and says when
   something it needs is missing.
4. **Safe by default.** Anything that sends, posts, pays, deletes or changes data: draft it and ask
   first. Say so in the instructions.
5. **Honest.** It never invents facts, numbers, sources, quotes or results, and it says when it isn't
   sure.
6. **Short.** Usually 30–80 lines of instructions. Long reference material goes in its own file.
7. **Useful `ask:` questions.** Two to four questions whose answers change what it does: whose
   emails matter, the brand voice, the main data table. Not trivia.

Good fits: code reviewer, inbox triage (drafts only), meeting notes, standup writer, research
assistant, data analyst (read-only), support replies, social posts, a chief of staff leading a team.
See [`agents/`](agents/) for working examples.

### Never

- **Secrets in an agent's files:** API keys, tokens, passwords. Access comes from connected apps.
- **Personal data in market agents:** real emails, phone numbers, names, home paths. Use
  `example.com`.
- **Agents built to deceive or harm:** impersonation, spam, phishing or collecting credentials,
  surveillance of people, evading security, harassment.
- **Pretending:** instructions that make it claim it sent, posted or did something it didn't.

### Adding an agent to the market

Put it in `agents/<name>/`, add it to the table in [`agents/README.md`](agents/README.md), run
`cd backend && uv run pytest tests/test_marketplace.py`, and open a pull request. Full rules are in
[CONTRIBUTING.md](CONTRIBUTING.md#adding-an-agent-to-the-market).

---

## Part 2: Working on this codebase

- **Layout:**
  - `backend/` is the FastAPI API (`app/`), the sandbox runner (`runner/runner.py`: standard library
    only), migrations (`alembic/`) and tests.
  - `frontend/` is React plus a canvas game map (`src/city/`).
  - `agents/` is the market.
  - The [README](README.md) has the full map and how to run everything.
- **Before you finish:**
  - `cd backend && uv run pytest`;
  - `cd frontend && npm run build && npx oxlint src`.

  CI runs the same on every pull request.
- **Database changes:** add a migration
  (`cd backend && uv run alembic revision --autogenerate -m "…"`), read it, and give new non-null
  columns a `server_default`.
- **Privacy is the core rule:**
  - every query is scoped to the signed-in user;
  - another user's things return **404**;
  - keys and tokens are encrypted at rest and never returned by the API;
  - the manifest a sandbox gets holds no secrets: credentials only travel through
    `/api/runtime/setup`, with the run's own token.
- **This is a public repository:** never commit secrets, `.env` files, databases or anyone's personal
  data. Test data is invented (`@example.com`).
- **Style:** match the code around you. Short functions, plain names, comments that say *why*. Keep
  user-facing words plain: "apps", not "MCP tools".
