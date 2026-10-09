# Privacy Policy

**Effective:** 9 October 2026

This policy covers the hosted Agent Town service run by Rushabh Singwi ("we", "us"). Agent Town is
also open-source software that anyone can run themselves: if you use a copy run by someone else,
**their** privacy policy applies, not this one.

**Contact:** `<privacy contact email>` <!-- maintainer: put the real address here before launch -->

## The short version

- We store what you put into Agent Town (your account, your agents, their files, your chats) so the
  service can work. That's it: no ads, no selling data, no analytics trackers.
- Your agents run on **your own** AI account (Claude or ChatGPT, by API key or subscription). What you
  say to an agent is sent to that provider under **your** agreement with them.
- Keys and tokens you give us are encrypted, never shown back to you, and only handed to your own
  agent's sandbox while it runs.
- Everything is private unless you choose **Share publicly**.

## What we collect, and why

| What | Why | Stored as |
|---|---|---|
| **Email address, username, password** | To create your account and sign you in | Password: a one-way hash (argon2id); we never know it |
| **Sign-in sessions and API tokens** | To keep you signed in, and to let your scripts use the API | Only a one-way hash of each token |
| **Your AI account keys or subscription tokens** (Anthropic, OpenAI) | So your agents can think, on your account | Encrypted; never returned by the API |
| **App connections** (for example a GitHub token, or an app's server address) and their credentials | So agents you allow can use those apps | Credentials encrypted; never returned by the API |
| **Your agents**: their instructions, files, "about you" answers, team and settings; your shared files | That's what an agent is | As you wrote them |
| **Chats with your agents**: your messages, the agent's replies, and the tool calls and results it made | To show you the conversation, and to continue it | As text, until you delete the agent |
| **What you share publicly**: agents or files, a note, your username | So others can see what you chose to share | As text, visible to everyone |
| **Technical logs**: IP address, time, request path, errors | To keep the service running and secure | In our hosting provider's logs, kept for a limited time |

We don't use advertising, tracking pixels or third-party analytics.

**Cookies and browser storage:** one cookie keeps you signed in (`agenttown_session`: HttpOnly,
not readable by scripts, and sent only to us). Your browser also remembers your map style
(`agenttown.theme`) on your own device. That's all.

## Who else handles your data

We use a few providers to run the service. Each only gets what it needs:

- **Render** hosts the app and its database, in the United States.
- **Modal** runs each agent's sandbox while you chat with it. For that run only, the sandbox gets
  the agent's instructions and files, your "about you" answers, the agent's team, and the
  credentials it needs (your AI key or token, and tokens for the apps you allowed). The sandbox is
  thrown away when the chat ends.
- **Anthropic or OpenAI**, whichever you choose: your agent sends your messages, its instructions
  and files, and tool results to them, **using your own account**. How they handle that data is set
  by your agreement with them.
- **Apps you connect** (for example GitHub): your agent reads from and writes to them, with the
  access you gave, when it uses them.

We don't sell or rent your data, and we don't share it with anyone else unless the law requires
it. If that happens, we'll tell you when we're allowed to.

## Google data

Agent Town doesn't connect to Google accounts yet. When it does, and if you connect Gmail or Google
Calendar:

- Agent Town's use and transfer of information received from Google APIs will adhere to the
  [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
  including the Limited Use requirements.
- Your agents will use that data only to do what you ask them to in Agent Town.
- We won't use it for advertising, won't sell it, won't let people read it except with your consent
  or for security or legal reasons, and won't use it to train AI models.
- You'll be able to disconnect at any time, which deletes the tokens we stored.

## How long we keep it

- **Agents, files, chats and connections:** until you delete them. Deleting an agent deletes its
  files and its chat history.
- **Keys, tokens and connections:** until you remove them in the app.
- **Your account:** until you delete it (see below). That deletes your account and everything in it
  straight away.
- **Backups and logs:** deleted data can stay in backups and hosting logs for a limited time, then
  it's gone.

## Your choices and rights

- **See and change** your agents, files, connections and keys in the app at any time.
- **Delete** any agent, file, key, token or connection in the app.
- **Delete your account** yourself: your @username (top right) → **Account** → **Delete my account**.
  It deletes your agents, files, chats, keys, app connections, tokens and public shares at once, and
  stops any agent that's running. If you can't sign in, email us from the address on your account.
- **Get a copy** of your data, or ask us to correct it: email us.
- Depending on where you live (for example under the GDPR in the EU and UK, or in California), you
  may have further rights, such as to object to or restrict how we use your data. Email us to use
  them. You can also complain to your local data protection authority.

## Security

Passwords and tokens are hashed; keys and app credentials are encrypted at rest. Every request is
checked against the signed-in account, so nobody can reach another person's agents, files or chats.
Agents run in isolated sandboxes that are thrown away after each chat. No system is perfectly
secure, so please don't put secrets you can't rotate into an agent's files.

## Children

Agent Town isn't meant for children. Don't use it if you're under 16 (or the age of digital consent
where you live).

## Changes

If we change this policy, we'll update the date above. For significant changes we'll tell you in
the app or by email before they take effect.
