// Where everything stands. Plain data in, plain data out; render.ts draws it.
//
//   Utilities (your MCP connections) │ Your district (private agents) │ Public district
//
// A building is one agent: one floor per file, biggest at the bottom; the floor's height comes
// from its line count, and the footprint grows with the number of files.

import type { City, Connection, Share, Status } from '../api'

export type RGB = [number, number, number]
export type Floor = { h: number; path: string }
export type ThingKind = 'agent' | 'shared' | 'library' | 'station'
export type Thing = {
  key: string; kind: ThingKind; id: number
  x: number; y: number; w: number; d: number
  floors: Floor[]; height: number; roof: RGB
  label: string; sub?: string; status?: Status
}
export type District = { kind: 'utilities' | 'private' | 'public'; x0: number; y0: number; w: number; h: number; label: string; empty: number[][] }
export type Wire = { from: Thing; to: Thing; status: Status }
export type Layout = { grid: [number, number]; districts: District[]; things: Thing[]; wires: Wire[] }

export const CELL = 4            // a lot is 3×3 tiles plus a 1-tile street
const MAX_HEIGHT = 170

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

function stack(files: { path: string; lines: number }[]): { floors: Floor[]; height: number } {
  const sorted = [...files].sort((a, b) => b.lines - a.lines)
  let floors = sorted.map(f => ({ path: f.path, h: Math.max(6, Math.min(24, 4 + Math.sqrt(f.lines) * 1.1)) }))
  const total = floors.reduce((s, f) => s + f.h, 0)
  if (total > MAX_HEIGHT) floors = floors.map(f => ({ ...f, h: f.h * MAX_HEIGHT / total }))
  return { floors, height: Math.min(total, MAX_HEIGHT) }
}

const footprint = (files: number) => (files <= 2 ? 2 : 3)

function grid(n: number, minCols: number, minRows: number) {
  const cols = Math.max(minCols, Math.ceil(Math.sqrt(n)))
  const rows = Math.max(minRows, Math.ceil(n / cols))
  return { cols, rows }
}

function place(x0: number, y0: number, cols: number, i: number, size: number) {
  const c = i % cols, r = Math.floor(i / cols)
  const off = Math.floor((CELL - 1 - size) / 2)
  return { x: x0 + 1 + c * CELL + off, y: y0 + 1 + r * CELL + off }
}

function emptyLots(x0: number, y0: number, cols: number, rows: number, used: number) {
  const out: number[][] = []
  for (let i = used; i < cols * rows; i++) {
    const c = i % cols, r = Math.floor(i / cols)
    out.push([x0 + 1 + c * CELL, y0 + 1 + r * CELL])
  }
  return out
}

export function layout(city: City): Layout {
  const districts: District[] = []
  const things: Thing[] = []
  const wires: Wire[] = []
  const y0 = 2
  let x = 2

  if (city.me) {
    // utilities: one small station per MCP connection, in a column
    const conns = city.connections
    const rows = Math.max(2, conns.length)
    const d: District = { kind: 'utilities', x0: x, y0, w: CELL + 1, h: rows * CELL + 1, label: 'Utilities · MCP', empty: [] }
    conns.forEach((c: Connection, i) => {
      const p = place(x, y0, 1, i, 2)
      things.push({
        key: `station:${c.id}`, kind: 'station', id: c.id, x: p.x, y: p.y, w: 2, d: 2,
        floors: [{ h: 16, path: '' }], height: 16, roof: [120, 124, 134],
        label: c.name, sub: STATUS_LABEL[c.status], status: c.status,
      })
    })
    d.empty = emptyLots(x, y0, 1, rows, conns.length)
    districts.push(d)
    x += d.w + 2

    // your private district
    const agents = city.agents
    const g = grid(agents.length, 2, 2)
    const pd: District = { kind: 'private', x0: x, y0, w: g.cols * CELL + 1, h: g.rows * CELL + 1,
      label: `@${city.me.username}'s district · private`, empty: [] }
    agents.forEach((a, i) => {
      const size = footprint(a.files.length)
      const p = place(x, y0, g.cols, i, size)
      const s = stack(a.files)
      things.push({ key: `agent:${a.id}`, kind: 'agent', id: a.id, x: p.x, y: p.y, w: size, d: size,
        ...s, roof: hex(a.color), label: a.name, sub: a.share_id ? 'shared' : undefined })
    })
    pd.empty = emptyLots(x, y0, g.cols, g.rows, agents.length)
    districts.push(pd)
    x += pd.w + 3

    // a wire from each station to every agent allowed to use it
    for (const c of conns) {
      const from = things.find(t => t.key === `station:${c.id}`)!
      for (const id of new Set(c.granted_to.map(g => g.agent_id))) {
        const to = things.find(t => t.key === `agent:${id}`)
        if (to) wires.push({ from, to, status: c.status })
      }
    }
  }

  // the public district: shared agents, plus a library of shared files
  const sharedAgents = city.public.filter((s: Share) => s.kind === 'agent' && s.agent)
  const sharedFiles = city.public.filter((s: Share) => s.kind === 'file' && s.file)
  const n = sharedAgents.length + (sharedFiles.length ? 1 : 0)
  const g = grid(n, 3, 2)
  const pub: District = { kind: 'public', x0: x, y0, w: g.cols * CELL + 1, h: g.rows * CELL + 1, label: 'Public district', empty: [] }
  let i = 0
  if (sharedFiles.length) {
    const p = place(x, y0, g.cols, i++, 3)
    const s = stack(sharedFiles.map(f => ({ path: String(f.id), lines: f.file!.lines })))
    things.push({ key: 'library', kind: 'library', id: 0, x: p.x, y: p.y, w: 3, d: 3, ...s,
      roof: [150, 104, 70], label: 'Library', sub: `${sharedFiles.length} shared files` })
  }
  for (const sh of sharedAgents) {
    const a = sh.agent!
    const size = footprint(a.files.length)
    const p = place(x, y0, g.cols, i++, size)
    things.push({ key: `shared:${sh.id}`, kind: 'shared', id: sh.id, x: p.x, y: p.y, w: size, d: size,
      ...stack(a.files), roof: hex(a.color), label: a.name, sub: `@${sh.owner}` })
  }
  pub.empty = emptyLots(x, y0, g.cols, g.rows, i)
  districts.push(pub)
  x += pub.w

  const H = Math.max(...districts.map(d => d.h)) + y0 + 2
  return { grid: [x + 2, H], districts, things, wires }
}
