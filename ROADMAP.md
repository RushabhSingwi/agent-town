# Roadmap

What's next for Agent Town, roughly in order. Want to help? Pick something, open an issue to say
you're on it, and see [CONTRIBUTING.md](CONTRIBUTING.md). Market agents are the easiest place to start.

## Next: the core product

These matter most for people who don't care how agents work: today agents answer when asked; they
should remember, work on a schedule, and show their work for approval.

- [ ] **Make an agent by describing it.** "I want something that preps me for every meeting." A
      builder asks 3–4 questions, writes the `AGENT.md`, picks its building and apps, and a new
      character moves into town. Nobody should have to write markdown.
- [ ] **Saved work.** A "Saved" shelf for what an agent produces: drafts, briefs, notes. Memory is
      done (its own notes, plus its last few chats); other files it writes are still gone when
      the chat ends.
- [ ] **Ask before acting: an approvals inbox.** A mailbox in the town square where agents leave
      requests ("Send this reply to Sam?": Approve / Edit / Reject). This makes sending email, calendar
      invites and Slack messages safe.
- [ ] **Routines.** Agents that work on a schedule: "every weekday at 8:00, summarize my inbox and
      calendar", "every Friday, draft my weekly update". Results arrive as letters in the town mailbox,
      with an optional email or phone notification.
- [ ] **More connectors:** Google Docs, Drive and Sheets (same Google sign-in), Notion, Slack, Linear
      or Jira, meeting transcripts (Zoom, Meet). Plus the standard MCP sign-in (OAuth with dynamic client
      registration) so any app that supports it connects without setup.
- [ ] **Google verification** for the hosted service, so Gmail and Calendar work for everyone without
      Testing mode's 7-day sign-ins.

## Market agents to add

Anyone can contribute these. See [`agents/`](agents/) and [AGENTS.md](AGENTS.md).

**Product managers:** PRD writer · user-interview synthesizer · feedback triage (tickets, reviews,
Slack → themes with counts) · release notes from merged PRs · backlog prioritizer (RICE) ·
competitor watcher (with routines) · meeting notes → draft tickets (with approvals).

**Tech-adjacent** (analysts, designers, marketers, ops): SQL buddy · spreadsheet helper · "explain
this spec to me" · campaign planner · SEO brief writer · content calendar.

**Everyone:** trip planner · meal and grocery planner · job application helper (CV and cover letter
for a job post) · study buddy (quizzes from your notes) · writing coach (in your own voice) · life
admin (renewals, bills, forms, with routines).

## The town

- [ ] Characters say what they're doing ("Reading 12 emails…", then "Drafted 3 replies").
- [ ] Agents level up as you use them: the house grows, the character gets new gear.
- [ ] A morning board in the square: what each agent did overnight.
- [ ] Customize a house, a character and the map by hand.
- [ ] Visit a friend's town and borrow their shared agents (the common area).

## Teams

- [ ] Team towns: invite colleagues, share agents and connected apps (a team Notion, a team Slack),
      with each person's private district beside the shared square.

## Platform

- [ ] An egress allowlist for sandboxes: they may reach only the model API and the apps they're granted.
- [ ] A warm pool of sandboxes for instant starts; streaming replies instead of polling.
- [ ] Email verification and password reset; rate limits on sign-in.
- [ ] Two-factor sign-in and trusted devices.
