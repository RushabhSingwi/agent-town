// Which building each agent and each tool gets, from what it's called and what it does.

export const AGENT_BUILDINGS = {
  studio: 'High-tech studio', office: 'Office', forge: 'Forge (blacksmith)', library: 'Library', lab: 'Lab',
  observatory: 'Observatory', tavern: 'Tavern', cottage: 'Cottage', tower: 'Tower',
} as const
export type AgentBuilding = keyof typeof AGENT_BUILDINGS

export const TOOL_BUILDINGS = {
  stable: 'Post stable', clocktower: 'Clock tower', workshop: 'Workshop', archive: 'Archive',
  signal: 'Signal tower', well: 'Well', barn: 'Barn',
} as const
export type ToolBuilding = keyof typeof TOOL_BUILDINGS

export type BuildingStyle = AgentBuilding | ToolBuilding | 'vault'

const AGENT_RULES: [RegExp, AgentBuilding][] = [
  [/chief|orchestr|manager|\blead|coordinat|boss|strateg|planner|of staff/, 'tower'],
  [/analytic|data|metric|dashboard|report|insight|stats|kpi/, 'observatory'],
  [/code|engineer|develop|\bdev\b|backend|frontend|mobile|\bapi\b|deploy|devops|bug|fix|pr review/, 'forge'],
  [/video|reel|design|creative|instagram|tiktok|photo|\bart\b|brand|youtube|podcast|music/, 'studio'],
  [/experiment|science|research|\bml\b|test|\bqa\b/, 'lab'],
  [/writ|blog|linkedin|newsletter|copy|docs|knowledge|teach|mentor|learn|read/, 'library'],
  [/assistant|personal|errand|inbox|remind|life|home|family|trip|travel/, 'cottage'],
  [/sales|support|customer|community|chat|host|friend/, 'tavern'],
]

export function agentBuilding(a: { building?: string; name: string; description: string }): AgentBuilding {
  if (a.building && a.building in AGENT_BUILDINGS) return a.building as AgentBuilding
  const text = `${a.name} ${a.description}`.toLowerCase()
  return AGENT_RULES.find(([re]) => re.test(text))?.[1] ?? 'office'
}

const TOOL_RULES: [RegExp, ToolBuilding][] = [
  [/mail|outlook|inbox|smtp/, 'stable'],
  [/calendar|\bcal\b|schedul|meeting/, 'clocktower'],
  [/github|gitlab|\bgit\b|linear|jira|sentry|vercel|render/, 'workshop'],
  [/notion|docs|drive|confluence|wiki|sheet|dropbox|file/, 'archive'],
  [/slack|discord|teams|telegram|whatsapp|\bsms\b|twilio|chat/, 'signal'],
  [/postgres|sql|\bdb\b|database|supabase|redis|mongo|bigquery|snowflake/, 'well'],
]

export function toolBuilding(c: { name: string; url: string | null; command: string | null }): ToolBuilding {
  const text = `${c.name} ${c.url ?? ''} ${c.command ?? ''}`.toLowerCase()
  return TOOL_RULES.find(([re]) => re.test(text))?.[1] ?? 'barn'
}

// ---------- how big an agent's building is, and how it's put together ----------
//
// Everything comes from the agent itself (later: customizable):
//   tier     its "importance": lines of what it knows, plus its tools and files (S, M, L, XL)
//   stories  how many files it has (1–3)
//   tools    one emblem on a side annex per connection it may use (up to 4)
//   banner   a flag on the roof when it's shared publicly

export type HouseSpec = {
  style: AgentBuilding; color: [number, number, number]
  tier: 0 | 1 | 2 | 3; stories: 1 | 2 | 3; tools: ToolBuilding[]; banner: boolean
}

export function importance(lines: number, files: number, tools: number) {
  return lines + 60 * tools + 40 * files
}

export function houseSpec(a: { lines: number; files: number; tools: ToolBuilding[]; shared: boolean }, style: AgentBuilding,
  color: [number, number, number]): HouseSpec {
  const score = importance(a.lines, a.files, a.tools.length)
  const tier = (score < 150 ? 0 : score < 500 ? 1 : score < 1500 ? 2 : 3) as HouseSpec['tier']
  const stories = Math.max(1, Math.min(3, Math.ceil(a.files / 3))) as HouseSpec['stories']
  return { style, color, tier, stories, tools: a.tools.slice(0, 4), banner: a.shared }
}

/** Sizes in art pixels (16 per tile): the main body, the annex for tools, and the whole sprite. */
export function houseSize(s: HouseSpec) {
  const body = [48, 64, 80, 96][s.tier]
  const annex = s.tools.length ? (s.tools.length <= 2 ? 16 : 32) : 0
  const wall = 18 + s.stories * 12 + (s.style === 'tower' ? 16 : 0)
  const roof = s.style === 'tower' ? 10 : s.style === 'office' || s.style === 'studio' ? 6 : Math.round(body * 0.36)
  return { body, annex, wall, roof, w: body + annex, h: wall + roof }
}
