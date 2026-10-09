// The apps people connect, in their words. Each is an MCP server underneath; most people never need
// to know that. `how` says what connecting takes today:
//   token  paste a personal access token; we connect to the app's hosted server with it
//   google "Sign in with Google": Agent Town hosts the tools itself (if this server has a Google client)
//   soon   needs "Sign in with …" (OAuth) for that app, which Agent Town doesn't do yet
//   custom any MCP server: a URL or a command (the "Advanced" form)

import type { Connection } from './api'

export type App = {
  key: string; name: string; icon: string; does: string; match: RegExp
  how: 'token' | 'google' | 'soon' | 'custom'
  url?: string; tokenHelp?: string; tokenLink?: string; google?: 'gmail' | 'calendar'
}

export const APPS: App[] = [
  { key: 'gmail', name: 'Gmail', icon: '✉️', does: 'read your email and write drafts (it never sends)', match: /gmail|mail|outlook/i, how: 'google', google: 'gmail' },
  { key: 'google-calendar', name: 'Google Calendar', icon: '📅', does: 'see your schedule and add events', match: /calendar|\bcal\b/i, how: 'google', google: 'calendar' },
  { key: 'github', name: 'GitHub', icon: '🐙', does: 'read issues, pull requests and code', match: /github/i, how: 'token',
    url: 'https://api.githubcopilot.com/mcp/', tokenLink: 'https://github.com/settings/personal-access-tokens/new',
    tokenHelp: 'Create a fine-grained token on GitHub with read access to the repositories you want, then paste it here.' },
  { key: 'notion', name: 'Notion', icon: '📒', does: 'read and write your notes and docs', match: /notion/i, how: 'soon' },
  { key: 'slack', name: 'Slack', icon: '💬', does: 'read channels and draft messages', match: /slack/i, how: 'soon' },
  { key: 'linear', name: 'Linear', icon: '📋', does: 'see and update your issues', match: /linear/i, how: 'soon' },
  { key: 'postgres', name: 'A database', icon: '🗄️', does: 'answer questions from your data (read-only)', match: /postgres|sql|database|\bdb\b/i, how: 'custom' },
]

export const appFor = (key: string) => APPS.find(a => a.key === key)

/** Your existing connection for this app, if you've connected it already. */
export const connectionFor = (app: App, conns: Connection[]) => app.google
  ? conns.find(c => c.app === app.google) ?? conns.find(c => !c.app && app.match.test(c.name))   // by what it is, not its name
  : conns.find(c => !c.app && app.match.test(`${c.name} ${c.url ?? ''} ${c.command ?? ''}`))

/** Which apps to suggest for an agent: what its market entry says, else a guess from what it does. */
export function suggestedApps(agent: { name: string; description: string }, marketTools: string[] | undefined): App[] {
  const keys = marketTools?.length ? marketTools : (() => {
    const t = `${agent.name} ${agent.description}`.toLowerCase()
    const out: string[] = []
    if (/mail|inbox|repl/.test(t)) out.push('gmail')
    if (/calendar|meeting|schedul|plan/.test(t)) out.push('google-calendar')
    if (/code|github|pull request|bug|engineer/.test(t)) out.push('github')
    if (/notes|docs|notion|write/.test(t)) out.push('notion')
    if (/data|metric|sql|analytic/.test(t)) out.push('postgres')
    return out.length ? out : ['gmail', 'google-calendar', 'notion']
  })()
  return keys.map(appFor).filter((a): a is App => !!a)
}
