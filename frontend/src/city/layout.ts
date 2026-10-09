// Where everything stands on the map, in tiles. Plain data in, plain data out; render.ts draws it.
//
// The town grows out of a square with a fountain. Winding roads branch out from it, and your agents'
// houses line them, each with a footpath to the road; a farm road leads west to your tools. People's
// shared agents sit around the square. It's all on an island with an uneven coast, ponds and woods.
// Everything is seeded by your username, so your town looks the same every visit, and a new agent
// takes the next spot along a road instead of reshuffling the rest.

import type { City, RunStatus, Status } from '../api'
import { brainLook, type BrainLook } from './brain'
import { agentBuilding, houseSize, houseSpec, toolBuilding, type BuildingStyle, type HouseSpec } from './kinds'

export type RGB = [number, number, number]
export type Pt = [number, number]
export type ThingKind = 'agent' | 'shared' | 'library' | 'station' | 'files'
export type Rect = { x: number; y: number; w: number; h: number }
export type Npc = { seed: number; color: RGB; role: BuildingStyle; status: RunStatus | null; brain?: BrainLook }
export type Thing = Rect & {                // x, y, w, h: the sprite's area in tiles; it stands on y + h
  key: string; kind: ThingKind; id: number
  style: BuildingStyle; color: RGB; spec?: HouseSpec
  door: Pt                                  // where you stand to talk to it
  via?: { road: number; at: number }        // where its footpath meets a road (roads[road][at])
  label: string; sub?: string; status?: Status; npc?: Npc
  server?: string                           // a tool's name in agents' tool calls: mcp__<server>__…
}
export type Decor = { kind: 'tree' | 'bush' | 'rock' | 'lamp' | 'bench' | 'stall' | 'hay' | 'flowers' | 'fountain' | 'sign'; x: number; y: number; r: number; text?: string }
export type Wire = { from: Thing; to: Thing; status: Status; team?: boolean }
export const Ground = { Water: 0, Sand: 1, Grass: 2, Field: 3, Plaza: 4 } as const
export type Ground = typeof Ground[keyof typeof Ground]
export type Layout = {
  grid: [number, number]; ground: Uint8Array        // one Ground per tile, row by row
  things: Thing[]; wires: Wire[]; roads: Pt[][]; paths: Pt[][]; decor: Decor[]
  plaza: { x: number; y: number; r: number }; fields: Rect[]
  blocks: Rect[]                                    // what you can't walk through (besides water)
  spawn: Pt; home: Rect                             // where you start; what "Fit" frames on a phone
}

export const T = 16                                 // art pixels per tile
const TOOL_PX = 64

export const hex = (c: string): RGB => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [138, 111, 209]
}

export const STATUS_COLOR: Record<Status, RGB> = {
  connected: [60, 207, 110], auth_required: [242, 181, 58], error: [229, 83, 75],
  needs_sandbox: [90, 160, 230], unknown: [154, 160, 166],
}

export const STATUS_LABEL: Record<Status, string> = {
  connected: 'connected', auth_required: 'needs credentials', error: 'error',
  needs_sandbox: 'runs in sandbox', unknown: 'not checked',
}

export const seedOf = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

function rng(seed: number) {                         // mulberry32: small, fast, repeatable
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const h2 = (x: number, y: number, s: number) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
/** Smooth value noise in [0, 1]. */
export function noise(x: number, y: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

type Item = Omit<Thing, 'x' | 'y' | 'door'>
const overlaps = (a: Rect, b: Rect, m = 0) => a.x - m < b.x + b.w && a.x + a.w + m > b.x && a.y - m < b.y + b.h && a.y + a.h + m > b.y

function distToPolyline(p: Pt, line: Pt[]) {
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i]
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L))
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy))
  }
  return best
}

/** A road that wanders out from (x, y) in roughly `angle`'s direction, one point per tile. */
function road(x: number, y: number, angle: number, len: number, rand: () => number): Pt[] {
  const pts: Pt[] = [[x, y]]
  let a = angle, turn = 0
  for (let i = 0; i < len; i++) {
    turn = turn * 0.8 + (rand() - 0.5) * 0.18
    a += turn
    a += (angle - a) * 0.08                          // drift back towards its heading
    x += Math.cos(a); y += Math.sin(a)
    pts.push([x, y])
  }
  return pts
}

/** Put items along a road, both sides, each with its door facing the road; extends the road as needed. */
function line(items: Item[], start: Pt, angle: number, rand: () => number, placed: Rect[], roads: Pt[][], paths: Pt[][], things: Thing[]) {
  if (!items.length) return null
  const maxLen = 30 + items.length * 14
  let r = road(start[0], start[1], angle, 30, rand)
  let i = 0, d = 3, side = rand() < 0.5 ? 1 : -1, lastAttach = 0
  const fits = (foot: Rect) => !placed.some(p => overlaps(foot, p, 0.8)) &&
    roads.concat([r]).every(rd => [[foot.x, foot.y], [foot.x + foot.w, foot.y], [foot.x, foot.y + foot.h], [foot.x + foot.w, foot.y + foot.h],
      [foot.x + foot.w / 2, foot.y + foot.h / 2], [foot.x + foot.w / 2, foot.y], [foot.x + foot.w / 2, foot.y + foot.h]].every(c => distToPolyline(c as Pt, rd) > 1.1))
  while (i < items.length && d < maxLen) {
    const k = Math.floor(d)
    if (k >= r.length - 2) { r = r.concat(road(r[r.length - 1][0], r[r.length - 1][1], angle, 20, rand).slice(1)); continue }
    const [px, py] = r[k], [qx, qy] = r[k + 1]
    const len = Math.hypot(qx - px, qy - py) || 1
    const nx = -(qy - py) / len, ny = (qx - px) / len     // the road's left-hand normal
    const it = items[i]
    // try this side, then the other: a house above the road keeps its yard between it and the road
    let rect: Rect | null = null, foot: Rect | null = null
    for (const sd of [side, -side]) {
      const above = ny * sd < 0
      const off = sd * (it.h / 2 + 1.7 + (above ? 2.4 : 0) + rand() * 0.8)
      const cx = px + nx * off, cy = py + ny * off
      const rc: Rect = { x: cx - it.w / 2, y: cy - it.h / 2, w: it.w, h: it.h }
      const ft: Rect = { x: rc.x - 0.5, y: rc.y, w: rc.w + 1, h: rc.h + 2.2 }   // the house plus its yard
      if (fits(ft)) { rect = rc; foot = ft; side = sd as 1 | -1; break }
    }
    if (rect && foot) {
      const door: Pt = [rect.x + (it.spec ? houseSize(it.spec).body : TOOL_PX) / T / 2, rect.y + rect.h + 0.6]
      // a footpath from the door, bending once, to the nearest point on the road
      let bi = 0, bd = Infinity
      r.forEach((p, j) => { const dd = Math.hypot(p[0] - door[0], p[1] - door[1]); if (dd < bd) { bd = dd; bi = j } })
      const best = r[bi]
      things.push({ ...it, ...rect, door, via: { road: roads.length, at: bi } })   // this road is pushed next
      placed.push(foot)
      lastAttach = Math.max(lastAttach, bi)
      paths.push([door, [door[0], (door[1] + best[1]) / 2 + 0.4], best])
      i++; side = -side as 1 | -1
      d += it.w * 0.55 + 1 + rand() * 1.5
    } else d += 0.7
  }
  const used = Math.min(r.length, Math.max(Math.ceil(d) + 3, lastAttach + 2))
  const kept = r.slice(0, used)
  roads.push(kept)
  return kept
}

/** The way a courier travels from one building to another: down its footpath, along its road to the
 *  square, across, and out along the other road. Points in tiles. */
export function route(L: Layout, from: Thing, to: Thing): Pt[] {
  if (!from.via || !to.via) return [from.door, to.door]
  const a = L.roads[from.via.road], b = L.roads[to.via.road]
  if (from.via.road === to.via.road) {
    const [i, j] = [from.via.at, to.via.at]
    const mid = i <= j ? a.slice(i, j + 1) : a.slice(j, i + 1).reverse()
    return [from.door, ...mid, to.door]
  }
  return [from.door, ...a.slice(0, from.via.at + 1).reverse(), [L.plaza.x, L.plaza.y + L.plaza.r * 0.55],
    ...b.slice(0, to.via.at + 1), to.door]
}

/** A lane round the island, out at sea, for boats. */
export function seaLane(L: Layout): Pt[] {
  const [W, H] = L.grid, m = 1.1
  return [[m, m], [W - m, m], [W - m, H - m], [m, H - m], [m, m]]
}

export function layout(city: City): Layout {
  const rand = rng(seedOf(city.me?.username ?? 'agent-town'))
  const things: Thing[] = [], placed: Rect[] = [], roads: Pt[][] = [], paths: Pt[][] = [], decor: Decor[] = [], fields: Rect[] = []
  const plaza = { x: 0, y: 0, r: 4.5 }
  placed.push({ x: -plaza.r - 1, y: -plaza.r - 1, w: plaza.r * 2 + 2, h: plaza.r * 2 + 2 })

  // the agents' houses, in the order they were made (so a new one takes the next spot)
  const toolsOf = (agentId: number) => (city.me ? city.connections : []).filter(c => c.granted_to.some(g => g.agent_id === agentId)).map(toolBuilding)
  const agents: Item[] = (city.me ? city.agents : []).map(a => {
    const style = agentBuilding(a), color = hex(a.color)
    const spec = houseSpec({ lines: a.lines, files: a.files.length, tools: toolsOf(a.id), shared: !!a.share_id }, style, color)
    const s = houseSize(spec)
    return { key: `agent:${a.id}`, kind: 'agent' as const, id: a.id, style, color, spec, w: s.w / T, h: s.h / T, label: a.name,
      sub: a.share_id ? 'shared' : undefined, npc: { seed: seedOf(a.slug), color, role: style, status: a.run_status ?? null, brain: brainLook(a.brain) } }
  })
  const files = city.me ? city.shared_files ?? [] : []
  if (files.length) agents.push({ key: 'files', kind: 'files', id: 0, style: 'vault', color: [92, 112, 140], w: 4, h: 4,
    label: 'Shared files', sub: `${files.length} files, all your agents` })

  // roads out of the square: agents north and east, the public south, the farm west
  const arms = Math.max(1, Math.min(5, Math.ceil(agents.length / 4)))
  const angles = [-Math.PI / 2 - 0.3, 0.15, -Math.PI / 4, Math.PI / 4 + 0.1, -Math.PI * 3 / 4].slice(0, arms)
  const per: Item[][] = angles.map(() => [])
  agents.forEach((a, i) => per[i % arms].push(a))
  angles.forEach((ang, k) => {
    const start: Pt = [Math.cos(ang) * (plaza.r + 0.5), Math.sin(ang) * (plaza.r + 0.5)]
    line(per[k], start, ang, rand, placed, roads, paths, things)
  })

  // the farm road west, with your tools and their fields
  const tools: Item[] = (city.me ? city.connections : []).map(c => ({
    key: `station:${c.id}`, kind: 'station' as const, id: c.id, style: toolBuilding(c), color: [150, 110, 70] as RGB,
    w: TOOL_PX / T, h: TOOL_PX / T, label: c.name, sub: STATUS_LABEL[c.status], status: c.status,
    server: c.app || c.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') }))
  const farm = line(tools, [-plaza.r - 0.5, 0.5], Math.PI, rand, placed, roads, paths, things)
  if (farm) decor.push({ kind: 'sign', x: farm[Math.min(4, farm.length - 1)][0], y: farm[Math.min(4, farm.length - 1)][1] - 1.6, r: 0, text: 'The farm · your tools' })

  // people's shared agents (and the library) around the square
  const pub: Item[] = []
  const sharedFiles = city.public.filter(s => s.kind === 'file' && s.file)
  if (sharedFiles.length) pub.push({ key: 'library', kind: 'library', id: 0, style: 'library', color: [150, 104, 70], w: 4, h: 4,
    label: 'Library', sub: `${sharedFiles.length} shared files` })
  for (const sh of city.public.filter(s => s.kind === 'agent' && s.agent)) {
    const a = sh.agent!, style = agentBuilding(a), color = hex(a.color)
    const spec = houseSpec({ lines: a.lines, files: a.files.length, tools: [], shared: true }, style, color)
    const s = houseSize(spec)
    pub.push({ key: `shared:${sh.id}`, kind: 'shared', id: sh.id, style, color, spec, w: s.w / T, h: s.h / T, label: a.name, sub: `@${sh.owner}`,
      npc: { seed: seedOf(`${sh.owner}/${a.slug}`), color, role: style, status: null } })
  }
  const south = Math.PI / 2 + 0.1
  if (pub.length) line(pub, [Math.cos(south) * (plaza.r + 0.5), Math.sin(south) * (plaza.r + 0.5)], south, rand, placed, roads, paths, things)

  // ---- the land: an island around everything, with ponds, fields and woods ----
  const pts = [...things.flatMap(t => [[t.x, t.y], [t.x + t.w, t.y + t.h + 2]] as Pt[]), ...roads.flat(), [-plaza.r, -plaza.r], [plaza.r, plaza.r]] as Pt[]
  const minX = Math.min(...pts.map(p => p[0])) - 7, minY = Math.min(...pts.map(p => p[1])) - 7
  const maxX = Math.max(...pts.map(p => p[0])) + 7, maxY = Math.max(...pts.map(p => p[1])) + 7
  const W = Math.ceil(maxX - minX), H = Math.ceil(maxY - minY)
  const sx = -minX, sy = -minY
  const shift = (p: Pt): Pt => [p[0] + sx, p[1] + sy]
  for (const t of things) { t.x += sx; t.y += sy; t.door = shift(t.door) }
  roads.forEach((r, i) => { roads[i] = r.map(shift) })
  paths.forEach((p, i) => { paths[i] = p.map(shift) })
  for (const d of decor) { d.x += sx; d.y += sy }
  plaza.x += sx; plaza.y += sy

  const seed = seedOf(city.me?.username ?? 'x') % 1000
  const near = (x: number, y: number, m: number) =>
    things.some(t => x > t.x - m && x < t.x + t.w + m && y > t.y - m && y < t.y + t.h + 2 + m) ||
    roads.some(r => distToPolyline([x, y], r) < m + 0.6) || Math.hypot(x - plaza.x, y - plaza.y) < plaza.r + m
  const ground = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cx = x + 0.5, cy = y + 0.5
    const ex = Math.min(cx, W - cx), ey = Math.min(cy, H - cy)      // distance to the map's edge
    const coast = Math.min(ex, ey) - 1.5 - noise(cx / 4, cy / 4, seed) * 4.5
    let g: Ground = coast < 0 ? Ground.Water : coast < 1 ? Ground.Sand : Ground.Grass
    if (g !== Ground.Grass && near(cx, cy, 1.5)) g = Ground.Grass
    ground[y * W + x] = g
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x + 0.5 - plaza.x, y + 0.5 - plaza.y) < plaza.r) ground[y * W + x] = Ground.Plaza

  // ponds where there's room
  for (let n = 0; n < 2 + Math.floor((W * H) / 900); n++) {
    const px = 3 + rand() * (W - 6), py = 3 + rand() * (H - 6), r = 1.6 + rand() * 2.2
    if (near(px, py, r + 2)) continue
    for (let y = Math.floor(py - r - 2); y <= py + r + 2; y++) for (let x = Math.floor(px - r - 2); x <= px + r + 2; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const d = Math.hypot(x + 0.5 - px, (y + 0.5 - py) * 1.3) - noise(x / 2, y / 2, seed + 7) * 1.4
      if (d < r) ground[y * W + x] = Ground.Water
      else if (d < r + 0.9 && ground[y * W + x] === Ground.Grass) ground[y * W + x] = Ground.Sand
    }
  }

  // fields behind the farm's buildings
  for (const t of things.filter(t => t.kind === 'station')) {
    const f: Rect = { x: t.x - 0.5, y: t.y - 3.5, w: t.w + 1, h: 3 }
    if (!roads.some(r => distToPolyline([f.x + f.w / 2, f.y + f.h / 2], r) < 2.5) && !things.some(o => o !== t && overlaps(f, { ...o, h: o.h + 2 }, 0.3))) {
      fields.push(f)
      for (let y = Math.floor(f.y); y < f.y + f.h; y++) for (let x = Math.floor(f.x); x < f.x + f.w; x++)
        if (x >= 0 && y >= 0 && x < W && y < H && ground[y * W + x] === Ground.Grass) ground[y * W + x] = Ground.Field
    }
    decor.push({ kind: 'hay', x: t.x + t.w + 0.6, y: t.y + t.h - 0.2, r: rand() })
  }

  // the square: a fountain, benches and a couple of stalls
  decor.push({ kind: 'fountain', x: plaza.x, y: plaza.y + 0.8, r: 0 })
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4
    decor.push({ kind: k % 2 ? 'stall' : 'bench', x: plaza.x + Math.cos(a) * (plaza.r - 1.2), y: plaza.y + Math.sin(a) * (plaza.r - 1.2) + 0.5, r: rand() })
  }
  decor.push({ kind: 'sign', x: plaza.x, y: plaza.y - plaza.r - 0.6, r: 0, text: city.me ? `@${city.me.username}'s town` : 'Agent Town' })

  // lamps along the roads, then woods, bushes, rocks and flowers wherever there's grass left
  for (const r of roads) for (let i = 4; i < r.length; i += 6) {
    const [ax, ay] = r[i - 1], [bx, by] = r[i]
    const L = Math.hypot(bx - ax, by - ay) || 1, side = i % 12 < 6 ? 1 : -1
    const lx = bx - (by - ay) / L * 1.2 * side, ly = by + (bx - ax) / L * 1.2 * side
    if (!things.some(t => lx > t.x - 0.3 && lx < t.x + t.w + 0.3 && ly > t.y && ly < t.y + t.h + 1)) decor.push({ kind: 'lamp', x: lx, y: ly, r: 0 })
  }
  const pathNear = (x: number, y: number) => paths.some(p => distToPolyline([x, y], p) < 1)
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (ground[y * W + x] !== Ground.Grass) continue
    const cx = x + 0.5, cy = y + 0.5
    if (near(cx, cy, 0.9) || pathNear(cx, cy)) continue
    const woods = noise(x / 6, y / 6, seed + 3), r = h2(x, y, seed)
    if (woods > 0.55 && r < (woods - 0.4) * 1.4) decor.push({ kind: 'tree', x: cx + (r - 0.5) * 0.6, y: cy + 0.5, r: h2(y, x, seed) })
    else if (r < 0.025) decor.push({ kind: 'bush', x: cx, y: cy + 0.4, r: h2(y, x, 1) })
    else if (r < 0.035) decor.push({ kind: 'rock', x: cx, y: cy + 0.3, r: h2(y, x, 2) })
    else if (r < 0.06) decor.push({ kind: 'flowers', x: cx, y: cy, r: h2(y, x, 3) })
  }

  const wires: Wire[] = []
  for (const c of city.me ? city.connections : []) {
    const from = things.find(t => t.key === `station:${c.id}`)
    for (const id of new Set(c.granted_to.map(g => g.agent_id))) {
      const to = things.find(t => t.key === `agent:${id}`)
      if (from && to) wires.push({ from, to, status: c.status })
    }
  }
  for (const a of city.me ? city.agents : []) {                    // a lead to each agent on its team
    const from = things.find(t => t.key === `agent:${a.id}`)
    for (const id of a.team ?? []) {
      const to = things.find(t => t.key === `agent:${id}`)
      if (from && to) wires.push({ from, to, status: 'connected', team: true })
    }
  }
  const blocks: Rect[] = things.map(t => ({ x: t.x + 0.2, y: t.y + t.h * 0.45, w: t.w - 0.4, h: t.h * 0.55 - 0.1 }))
  blocks.push({ x: plaza.x - 1.5, y: plaza.y - 0.7, w: 3, h: 1.9 })              // the fountain
  return {
    grid: [W, H], ground, things, wires, roads, paths, decor, plaza, fields, blocks,
    spawn: [plaza.x, plaza.y + plaza.r - 1], home: { x: plaza.x - 14, y: plaza.y - 11, w: 28, h: 22 },
  }
}
