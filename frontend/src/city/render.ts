// Draws a Layout as a 2D top-down game world, with you in it. No framework: one
// requestAnimationFrame loop. The ground and every building are drawn once into offscreen canvases
// (per theme); each frame copies those, then draws what moves: you, the NPCs, smoke, flags.
//
// You: W A S D or the arrow keys (Shift runs), or click/tap the ground to walk there. Walk up to an
// agent and press E to talk to it. Click a building to open it (and walk to its door).

import type { RunStatus } from '../api'
import { Paint, css, drawBench, drawBoat, drawBubble, drawBuilding, drawBush, drawCart, drawFlowers, drawFountain, drawHay, drawHorse, drawHouse,
  drawHouseLive, drawLamp, drawLive, drawNpc, drawRock, drawSignpost, drawStall, drawTree, hash, type Anchors, type NpcPose, type Vehicle } from './sprites'
import { Ground, STATUS_COLOR, T, noise, route, seaLane, type Decor, type Layout, type Rect, type Thing, type Wire } from './layout'
import type { BuildingStyle } from './kinds'
import { THEMES, type Theme, type ThemeName } from './themes'

const PAD = 28                       // room above a building's sprite for chimneys, flags, smoke
const SPEED = 4.2                    // tiles per second (Shift: faster)
const REACH = 1.8                    // how close you need to be to talk

type Pt = [number, number]
const DECOR_SIZE: Record<Decor['kind'], [number, number]> = {
  tree: [16, 24], bush: [16, 16], rock: [16, 16], flowers: [16, 16], lamp: [16, 24], bench: [16, 16], stall: [16, 24], hay: [16, 16], sign: [16, 24], fountain: [48, 32],
}
type Walker = { x: number; y: number; tx: number; ty: number; wait: number; dir: 1 | -1; dist: number }
type Player = Walker & { target: Pt | null; moving: boolean }
type Courier = { vehicle: Vehicle; pts: Pt[]; seg: number; along: number; speed: number; color: [number, number, number]; live: boolean; dist: number; dir: 1 | -1 }

// how each kind of app's work travels: mail and calendar by rider, chat and the outside world by boat
const VEHICLE: Partial<Record<BuildingStyle, Vehicle>> = { stable: 'horse', clocktower: 'horse', signal: 'boat', barn: 'boat' }
const CARGO: Partial<Record<BuildingStyle, [number, number, number]>> = {
  stable: [200, 60, 60], clocktower: [240, 200, 80], workshop: [90, 90, 110], archive: [230, 220, 190],
  signal: [80, 140, 220], well: [70, 130, 200], barn: [180, 60, 50],
}

export class CityView {
  private ctx: CanvasRenderingContext2D
  private canvas: HTMLCanvasElement
  private L: Layout | null = null
  private theme: Theme = THEMES.retro
  private view = { x: 0, y: 0, zoom: 2 }
  private selected: string | null = null
  private drag: { x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | null = null
  private raf = 0
  private last = 0
  private ground: HTMLCanvasElement | null = null
  private sprites = new Map<string, { cv: HTMLCanvasElement; anchors?: Anchors }>()
  private walkers = new Map<string, Walker>()
  private status = new Map<number, RunStatus | null>()
  private keys = new Set<string>()
  private player: Player | null = null
  private playerName = 'you'
  private near: Thing | null = null
  private follow = false
  private bottomInset = 0
  private sideInsets: [number, number] = [0, 0]
  private cam: Pt | null = null
  private couriers: Courier[] = []
  private nextTrip = 0
  onSelect: (t: Thing | null, floor: string | null) => void = () => {}

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.resize()
    canvas.addEventListener('pointerdown', this.down)
    window.addEventListener('pointermove', this.move)
    window.addEventListener('pointerup', this.up)
    canvas.addEventListener('wheel', this.wheel, { passive: false })
    window.addEventListener('resize', this.resize)
    window.addEventListener('keydown', this.keydown)
    window.addEventListener('keyup', this.keyup)
    window.addEventListener('blur', this.blur)
    this.raf = requestAnimationFrame(this.frame)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('pointermove', this.move)
    window.removeEventListener('pointerup', this.up)
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('keydown', this.keydown)
    window.removeEventListener('keyup', this.keyup)
    window.removeEventListener('blur', this.blur)
  }

  setTheme(name: ThemeName) {
    if (this.theme.name === name) return
    this.theme = THEMES[name]
    this.sprites.clear()
    if (this.L) this.ground = this.paintGround(this.L)
  }

  setLayout(L: Layout, refit: boolean) {
    const firstTime = !this.L
    this.L = L
    this.sprites.clear()
    this.ground = this.paintGround(L)
    for (const t of L.things) if (t.kind === 'agent' && t.npc) this.status.set(t.id, t.npc.status)
    const [W, H] = L.grid
    if (!this.player || this.player.x > W - 1 || this.player.y > H - 1 || this.collides(this.player.x, this.player.y)) {
      this.player = { x: L.spawn[0], y: L.spawn[1], tx: 0, ty: 0, wait: 0, dir: 1, dist: 0, target: null, moving: false }
    }
    if (firstTime || refit) this.fit()
  }

  setPlayerName(name: string) { this.playerName = name }
  /** A chat's run changed state: the NPC walks to its door to work, or wanders again. */
  setAgentStatus(agentId: number, s: RunStatus | null) { this.status.set(agentId, s) }
  /** Everyone's state at once (from /api/runs/active): agents not listed are asleep. */
  setStatuses(awake: { agent_id: number; status: RunStatus }[]) {
    const on = new Map(awake.map(a => [a.agent_id, a.status]))
    for (const t of this.L?.things ?? []) if (t.kind === 'agent') this.status.set(t.id, on.get(t.id) ?? null)
  }

  /** An agent just used an app's tool (mcp__<server>__…): send that app's courier to it, now. */
  sendCourier(agentId: number, server: string) {
    const w = this.L?.wires.find(x => !x.team && x.to.id === agentId && x.to.kind === 'agent' && x.from.server === server)
    if (w) this.spawn(w, true)
  }

  private spawn(w: Wire, live: boolean) {
    const L = this.L!
    const vehicle = VEHICLE[w.from.style] ?? 'cart'
    let pts: Pt[]
    if (vehicle === 'boat') {                          // round the island by sea, the short way
      const lane = seaLane(L), ring: Pt[] = []
      for (let i = 1; i < lane.length; i++) {
        const [a, b] = [lane[i - 1], lane[i]], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]))
        for (let j = 0; j < n; j++) ring.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n])
      }
      const near = (p: Pt) => ring.reduce((bi, q, i) => Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(ring[bi][0] - p[0], ring[bi][1] - p[1]) ? i : bi, 0)
      const i = near(w.from.door), j = near(w.to.door), n = ring.length
      const fwd = (j - i + n) % n, back = (i - j + n) % n
      pts = []
      for (let k = 0; k <= Math.min(fwd, back); k++) pts.push(ring[(i + (fwd <= back ? k : -k) + n) % n])
    } else pts = route(L, w.from, w.to)
    const tiles = vehicle === 'boat' ? 2.2 : vehicle === 'cart' ? 1.8 : 2.6
    this.couriers.push({ vehicle, pts: pts.map(([x, y]) => [x * T, y * T] as Pt), seg: 1, along: 0,
      speed: tiles * T * (live ? 2.4 : 1), color: CARGO[w.from.style] ?? [180, 140, 90], live, dist: 0, dir: 1 })
  }

  private stepCouriers(dt: number, now: number) {
    const tools = this.L!.wires.filter(w => !w.team)
    if (tools.length && now > this.nextTrip && this.couriers.filter(c => !c.live).length < Math.min(5, tools.length)) {
      this.spawn(tools[Math.floor(Math.random() * tools.length)], false)
      this.nextTrip = now + 5000 + Math.random() * 9000          // now and then, so the roads feel used
    }
    for (const c of this.couriers) {
      let left = c.speed * dt
      while (left > 0 && c.seg < c.pts.length) {
        const [a, b] = [c.pts[c.seg - 1], c.pts[c.seg]]
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]), rest = len - c.along
        if (Math.abs(b[0] - a[0]) > 0.5) c.dir = b[0] > a[0] ? 1 : -1
        if (left < rest) { c.along += left; c.dist += left; left = 0 }
        else { left -= rest; c.dist += rest; c.seg++; c.along = 0 }
      }
    }
    this.couriers = this.couriers.filter(c => c.seg < c.pts.length)
  }

  private courierAt(c: Courier): Pt {
    const [a, b] = [c.pts[c.seg - 1], c.pts[c.seg]]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [a[0] + (b[0] - a[0]) * c.along / len, a[1] + (b[1] - a[1]) * c.along / len]
  }
  setSelected(key: string | null) { this.selected = key }
  setHoverFloor(_path: string | null) {}
  setBottomInset(px: number) { this.bottomInset = px }
  setSideInsets(left: number, right: number) { this.sideInsets = [left, right] }

  private center(): Pt {
    const [left, right] = this.sideInsets
    return [(left + innerWidth - right) / 2, (70 + innerHeight - this.bottomInset) / 2]
  }

  /** Glide so this thing sits in the middle of the open space: above the card, between the side panels. */
  focusOn(key: string) {
    const t = this.L?.things.find(x => x.key === key)
    if (!t) return
    if (this.view.zoom < 2) this.view.zoom = 2
    const [cx, cy] = this.center()
    this.follow = false
    this.cam = [cx - (t.x + t.w / 2) * T * this.view.zoom, cy - (t.y + t.h / 2 + 1) * T * this.view.zoom]
  }

  /** The whole map if it fits at a readable size; otherwise (phones) your own town. */
  fit = () => {
    if (!this.L) return
    const [W, H] = this.L.grid
    const availH = innerHeight - 70 - this.bottomInset
    let r: Rect = { x: 0, y: 0, w: W, h: H }
    if (Math.min((innerWidth - 24) / (W * T), availH / (H * T)) < (innerWidth < 700 ? 0.75 : 0.4)) r = this.L.home
    this.follow = false; this.cam = null
    this.view.zoom = Math.max(0.35, Math.min(3, (innerWidth - 24) / (r.w * T), availH / (r.h * T)))
    this.view.x = (innerWidth - r.w * T * this.view.zoom) / 2 - r.x * T * this.view.zoom
    this.view.y = 70 + (availH - r.h * T * this.view.zoom) / 2 - r.y * T * this.view.zoom
  }

  private resize = () => {
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = innerWidth * dpr
    this.canvas.height = innerHeight * dpr
  }

  // ---------- you: keys, collisions, talking ----------

  private typing(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  }

  private keydown = (e: KeyboardEvent) => {
    if (this.typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key.toLowerCase()
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
      this.keys.add(k)
      if (k.startsWith('arrow')) e.preventDefault()
    }
    if ((k === 'e' || k === 'enter') && this.near && !e.repeat) { this.onSelect(this.near, null); e.preventDefault() }
  }
  private keyup = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()) }
  private blur = () => { this.keys.clear() }

  private collides(x: number, y: number) {
    const L = this.L!
    const [W, H] = L.grid
    if (x < 0.5 || y < 0.5 || x > W - 0.5 || y > H - 0.5) return true
    const r = 0.28
    for (const [cx, cy] of [[x - r, y], [x + r, y], [x, y - 0.2]]) if (L.ground[Math.floor(cy) * W + Math.floor(cx)] === Ground.Water) return true
    return L.blocks.some(b => x + r > b.x && x - r < b.x + b.w && y > b.y && y - 0.3 < b.y + b.h)
  }

  private stepPlayer(dt: number) {
    const p = this.player
    if (!p || !this.L) return
    let vx = 0, vy = 0
    const k = this.keys
    if (k.has('a') || k.has('arrowleft')) vx -= 1
    if (k.has('d') || k.has('arrowright')) vx += 1
    if (k.has('w') || k.has('arrowup')) vy -= 1
    if (k.has('s') || k.has('arrowdown')) vy += 1
    if (vx || vy) { p.target = null; this.follow = true; this.cam = null }
    else if (p.target) {
      const dx = p.target[0] - p.x, dy = p.target[1] - p.y, d = Math.hypot(dx, dy)
      if (d < 0.1) p.target = null
      else { vx = dx / d; vy = dy / d }
    }
    const n = Math.hypot(vx, vy)
    p.moving = n > 0
    if (!n) return
    const v = SPEED * (k.has('shift') ? 1.7 : 1) * dt / n
    const nx = p.x + vx * v, ny = p.y + vy * v
    const before = [p.x, p.y]
    if (!this.collides(nx, p.y)) p.x = nx
    if (!this.collides(p.x, ny)) p.y = ny
    if (p.x === before[0] && p.y === before[1]) p.target = null      // walked into a wall: stop trying
    if (vx) p.dir = vx > 0 ? 1 : -1
    p.dist += Math.hypot(p.x - before[0], p.y - before[1])
  }

  private findNear(): Thing | null {
    const p = this.player
    if (!p || !this.L) return null
    let best: Thing | null = null, bd = REACH
    for (const t of this.L.things) {
      let d = Math.hypot(t.door[0] - p.x, t.door[1] - p.y)
      const w = t.npc && this.walkers.get(t.key)
      if (w) d = Math.min(d, Math.hypot(w.x - p.x, w.y - p.y) + 0.3)
      if (d < bd) { bd = d; best = t }
    }
    return best
  }

  // ---------- the ground, painted once ----------

  private paintGround(L: Layout): HTMLCanvasElement {
    const th = this.theme, R = th.res
    const [W, H] = L.grid
    const cv = document.createElement('canvas')
    cv.width = W * T * R; cv.height = H * T * R
    const c = cv.getContext('2d')!
    c.scale(R, R)
    const p = new Paint(c, th)
    const g = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? Ground.Water : L.ground[y * W + x])

    const soft = th.style === 'soft'
    const land = (x: number, y: number) => g(x, y) !== Ground.Water
    if (soft) {                                    // painted style: water everywhere, then rounded shores
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.tileWater(p, x * T, y * T, x, y)
      c.fillStyle = css(th.sand)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (land(x, y)) { c.beginPath(); c.arc(x * T + 8, y * T + 8, 13, 0, 7); c.fill() }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const px = x * T, py = y * T, k = g(x, y)
      if (soft && (k === Ground.Water || !land(x - 1, y) || !land(x + 1, y) || !land(x, y - 1) || !land(x, y + 1))) continue
      if (k === Ground.Water) this.tileWater(p, px, py, x, y)
      else if (k === Ground.Sand) this.tileFlat(p, px, py, th.sand, x, y, true)
      else if (k === Ground.Plaza) this.tileCobble(p, px, py, x, y)
      else if (k === Ground.Field) {
        this.tileFlat(p, px, py, th.dirt, x, y, false)
        for (let i = 0; i < 4; i++) { c.fillStyle = css(th.leaf[(x + i) % th.leaf.length], 1.1); c.fillRect(px + 1 + i * 4, py + 3, 2, 10) }   // crop rows
      } else this.tileGrass(p, px, py, x, y, 0.97 + noise(x / 5, y / 5, 11) * 0.08)
      if (!soft && k !== Ground.Water) {                                           // foam where land meets water
        c.fillStyle = 'rgba(255,255,255,0.45)'
        if (g(x, y - 1) === Ground.Water) c.fillRect(px, py, T, 1)
        if (g(x, y + 1) === Ground.Water) c.fillRect(px, py + T - 1, T, 1)
        if (g(x - 1, y) === Ground.Water) c.fillRect(px, py, 1, T)
        if (g(x + 1, y) === Ground.Water) c.fillRect(px + T - 1, py, 1, T)
      }
    }
    // roads and footpaths: stamped discs along each line, edge first, then the surface
    const stamp = (line: Pt[], r: number, col: [number, number, number], k: number) => {
      if (soft) {                                  // painted: one smooth stroke
        c.strokeStyle = css(col, k); c.lineWidth = r * 2; c.lineCap = 'round'; c.lineJoin = 'round'
        c.beginPath(); line.forEach(([x, y], i) => (i ? c.lineTo(x * T, y * T) : c.moveTo(x * T, y * T))); c.stroke()
        return
      }
      c.fillStyle = css(col, k)                    // pixels: flat discs along the line
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1], [bx, by] = line[i]
        const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 4)
        for (let j = 0; j <= n; j++) {
          const t = j / n, cx = (ax + (bx - ax) * t) * T, cy = (ay + (by - ay) * t) * T
          for (let dy = -r; dy <= r; dy++) {
            const half = Math.round(Math.sqrt(r * r - dy * dy))
            c.fillRect(Math.round(cx - half), Math.round(cy + dy), half * 2, 1)
          }
        }
      }
    }
    for (const r of L.roads) stamp(r, 14, th.path, 0.8)
    for (const pa of L.paths) stamp(pa, 6, th.path, 0.85)
    for (const r of L.roads) stamp(r, 12, th.path, 1)
    for (const pa of L.paths) stamp(pa, 4.5, th.path, 1.04)
    for (const r of L.roads) for (let i = 0; i < r.length; i += 1) {                // ruts and pebbles
      const [x, y] = r[i], h = hash(i, Math.round(x * 7))
      c.fillStyle = css(th.path, h < 0.5 ? 0.85 : 1.1); c.fillRect(Math.round(x * T + (h - 0.5) * 14), Math.round(y * T + (hash(i, 3) - 0.5) * 14), 2, 1)
    }
    // the square's paving ring
    c.strokeStyle = css(th.cobble, 0.75); c.lineWidth = 3
    c.beginPath(); c.arc(L.plaza.x * T, L.plaza.y * T, L.plaza.r * T - 2, 0, 7); c.stroke()
    // fences round the fields
    for (const f of L.fields) {
      c.fillStyle = css(th.wood)
      for (let x = f.x * T; x <= (f.x + f.w) * T; x += 6) { c.fillRect(x, f.y * T - 2, 2, 5); c.fillRect(x, (f.y + f.h) * T - 2, 2, 5) }
      c.fillRect(f.x * T, f.y * T, f.w * T, 1); c.fillRect(f.x * T, (f.y + f.h) * T, f.w * T, 1)
    }
    return cv
  }

  private tileGrass(p: Paint, px: number, py: number, x: number, y: number, k = 1) {
    const th = this.theme, c = p.c
    if (th.style === 'blocks') {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        c.fillStyle = css(th.grass[Math.floor(hash(x * 4 + i, y * 4 + j) * 3)], k)
        c.fillRect(px + i * 4, py + j * 4, 4, 4)
      }
      return
    }
    c.fillStyle = css(th.grass[0], k); c.fillRect(px, py, T, T)
    if (th.style === 'soft') {
      for (let i = 0; i < 3; i++) {
        const r = hash(x * 3 + i, y * 7)
        c.fillStyle = css(th.grass[1 + (i % 2)], k, 0.35); c.beginPath(); c.arc(px + r * 16, py + hash(y, x + i) * 16, 4 + r * 4, 0, 7); c.fill()
      }
    } else {
      for (let i = 0; i < 6; i++) {
        const r = hash(x * 11 + i, y * 5 + i)
        c.fillStyle = css(th.grass[r < 0.5 ? 1 : 2], k)
        c.fillRect(px + Math.floor(r * 15), py + Math.floor(hash(y + i, x) * 14), 1, 2)
      }
    }
    const f = hash(x * 7, y * 3)
    if (f < 0.05) { c.fillStyle = css(th.flowers[Math.floor(f * 60) % th.flowers.length]); c.fillRect(px + 6, py + 7, 2, 2); c.fillRect(px + 10, py + 11, 2, 2) }
  }

  private tileFlat(p: Paint, px: number, py: number, col: [number, number, number], x: number, y: number, road: boolean) {
    const c = p.c
    c.fillStyle = css(col, road ? 1 : 0.92); c.fillRect(px, py, T, T)
    for (let i = 0; i < 5; i++) {
      const r = hash(x * 13 + i, y * 17 + i)
      c.fillStyle = css(col, r < 0.5 ? 0.86 : 1.08)
      if (this.theme.style === 'blocks') c.fillRect(px + Math.floor(r * 4) * 4, py + Math.floor(hash(y, x + i) * 4) * 4, 4, 4)
      else c.fillRect(px + Math.floor(r * 15), py + Math.floor(hash(y + i, x) * 15), 2, 1)
    }
  }

  private tileCobble(p: Paint, px: number, py: number, x: number, y: number) {
    const c = p.c, col = this.theme.cobble
    c.fillStyle = css(col, 0.8); c.fillRect(px, py, T, T)
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      c.fillStyle = css(col, 0.95 + hash(x * 2 + i, y * 2 + j) * 0.15)
      c.fillRect(px + i * 8 + ((y + j) % 2 ? 2 : 0) + 1, py + j * 8 + 1, 6, 6)
    }
  }

  private tileWater(p: Paint, px: number, py: number, x: number, y: number) {
    const c = p.c, col = this.theme.water
    c.fillStyle = css(col); c.fillRect(px, py, T, T)
    c.fillStyle = css(col, 1.25, 0.6)
    const r = hash(x, y)
    if (this.theme.style === 'blocks') c.fillRect(px + Math.floor(r * 3) * 4, py + 6, 4, 2)
    else { c.fillRect(px + 3 + r * 6, py + 5, 5, 1); c.fillRect(px + 8 - r * 4, py + 11, 4, 1) }
  }

  // ---------- sprites, cached per theme ----------

  private sprite(key: string, w: number, h: number, draw: (p: Paint) => Anchors | void) {
    let s = this.sprites.get(key)
    if (!s) {
      const R = this.theme.res, cv = document.createElement('canvas')
      cv.width = Math.ceil(w * R); cv.height = Math.ceil(h * R)
      const c = cv.getContext('2d')!
      c.scale(R, R)
      const anchors = draw(new Paint(c, this.theme, w * 31 + h)) || undefined
      s = { cv, anchors }
      this.sprites.set(key, s)
    }
    return s
  }

  private buildingSprite(t: Thing) {
    const w = t.w * T, h = t.h * T
    if (t.spec) {
      const s = t.spec
      return this.sprite(`h:${s.style}:${s.color}:${s.tier}:${s.stories}:${s.tools}:${s.banner}`, w, h + PAD, p => {
        p.c.translate(0, PAD); return drawHouse(p, s)
      })
    }
    return this.sprite(`b:${t.style}:${t.color}`, w, h + PAD, p => { p.c.translate(0, PAD); drawBuilding(p, t.style, t.color) })
  }

  // ---------- NPCs ----------

  private yard(t: Thing): Rect { return { x: t.door[0] - 2.2, y: t.door[1] + 0.1, w: 4.4, h: 1.5 } }

  private walker(t: Thing): Walker {
    let w = this.walkers.get(t.key)
    const y = this.yard(t)
    if (!w || w.x < y.x - 1 || w.x > y.x + y.w + 1 || w.y > y.y + y.h + 1) {
      const r = hash(t.id, t.key.length)
      w = { x: y.x + r * y.w, y: y.y + y.h * 0.5, tx: 0, ty: 0, wait: r * 2, dir: 1, dist: 0 }
      w.tx = w.x; w.ty = w.y
      this.walkers.set(t.key, w)
    }
    return w
  }

  private stepWalker(t: Thing, w: Walker, dt: number, s: RunStatus | null | undefined) {
    const atWork = s === 'busy' || s === 'starting'
    if (atWork) { w.tx = t.door[0] + 0.7; w.ty = t.door[1] - 0.2; w.wait = 0 }
    const dx = w.tx - w.x, dy = w.ty - w.y, d = Math.hypot(dx, dy)
    if (d > 0.05) {
      const v = Math.min(d, (atWork ? 2.6 : 1.1) * dt)
      w.x += dx / d * v; w.y += dy / d * v; w.dist += v
      if (Math.abs(dx) > 0.02) w.dir = dx > 0 ? 1 : -1
      return true
    }
    if (atWork) return false
    w.wait -= dt
    if (w.wait <= 0) {
      const y = this.yard(t)
      w.tx = y.x + Math.random() * y.w; w.ty = y.y + Math.random() * y.h; w.wait = 1 + Math.random() * 3
    }
    return false
  }

  // ---------- each frame ----------

  private focus(): Set<string> | null {
    if (!this.selected || !this.L) return null
    const s = new Set([this.selected])
    for (const w of this.L.wires) {
      if (w.from.key === this.selected) s.add(w.to.key)
      if (w.to.key === this.selected) s.add(w.from.key)
    }
    return s
  }

  /** When something is selected: arcs from its tools to it (or from a tool to the agents that use it). */
  private drawTrails(c: CanvasRenderingContext2D, now: number) {
    if (!this.selected) return
    for (const w of this.L!.wires) {
      if (w.from.key !== this.selected && w.to.key !== this.selected) continue
      const a: Pt = [w.from.door[0] * T, w.from.door[1] * T], b: Pt = [w.to.door[0] * T, w.to.door[1] * T]
      const mid: Pt = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 40]
      c.strokeStyle = w.team ? 'rgba(190,140,255,0.95)' : css(STATUS_COLOR[w.status], 1, 0.9); c.lineWidth = 2
      c.setLineDash(w.status === 'connected' ? [5, 4] : [2, 4]); c.lineDashOffset = -now / 50
      c.beginPath(); c.moveTo(a[0], a[1]); c.quadraticCurveTo(mid[0], mid[1], b[0], b[1]); c.stroke()
    }
    c.setLineDash([]); c.lineWidth = 1
  }

  private label(text: string, sx: number, sy: number, size = 11, sub?: string, dim = false, sel = false) {
    const c = this.ctx, th = this.theme
    c.font = th.font(size)
    const w1 = c.measureText(text).width
    c.font = th.font(size - 2, false)
    const w2 = sub ? c.measureText(sub).width : 0
    const w = Math.max(w1, w2) + 12, h = sub ? size * 2 + 7 : size + 8
    c.globalAlpha = dim ? 0.55 : 1
    c.fillStyle = sel ? '#ffd98f' : th.label.bg
    c.beginPath(); c.roundRect(Math.round(sx - w / 2), Math.round(sy - h), Math.round(w), h, th.style === 'pixel' ? 0 : 5); c.fill()
    if (th.label.edge !== 'transparent') { c.strokeStyle = th.label.edge; c.lineWidth = 1; c.stroke() }
    c.textAlign = 'center'; c.fillStyle = sel ? '#241f2e' : th.label.fg
    c.font = th.font(size); c.fillText(text, sx, sy - (sub ? size + 2 : 5))
    if (sub) { c.font = th.font(size - 2, false); c.fillStyle = sel ? '#5a4a30' : th.label.sub; c.fillText(sub, sx, sy - 5) }
    c.globalAlpha = 1
  }

  private frame = (now: number) => {
    // always ask for the next frame first: one bad frame mustn't freeze the map
    this.raf = requestAnimationFrame(this.frame)
    try { this.draw(now) } catch (e) { console.error(e) }
  }

  private draw(now: number) {
    const c = this.ctx, th = this.theme
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000)
    this.last = now
    const dpr = window.devicePixelRatio || 1
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.fillStyle = th.bg; c.fillRect(0, 0, this.canvas.width, this.canvas.height)
    if (!this.L || !this.ground) return

    this.stepPlayer(dt)
    this.stepCouriers(dt, now)
    this.near = this.findNear()
    const pl = this.player!
    if (this.follow) {                                   // keep you in the middle of the open space
      const [cx, cy] = this.center()
      if (this.view.zoom < 2) this.view.zoom = 2
      this.cam = [cx - pl.x * T * this.view.zoom, cy - (pl.y - 0.6) * T * this.view.zoom]
    }

    const z = this.view.zoom
    c.setTransform(z * dpr, 0, 0, z * dpr, this.view.x * dpr, this.view.y * dpr)
    c.imageSmoothingEnabled = th.style === 'soft'
    const [W, H] = this.L.grid
    c.drawImage(this.ground, 0, 0, W * T, H * T)
    const focus = this.focus()

    // everything that stands up, painted back to front
    const items: { y: number; draw: () => void }[] = []
    for (const d of this.L.decor) {
      const [w, h] = DECOR_SIZE[d.kind], dx = d.x * T - w / 2, dy = d.y * T - h
      if (d.kind === 'fountain') { items.push({ y: d.y * T, draw: () => { c.save(); c.translate(dx, dy); drawFountain(new Paint(c, th), now); c.restore() } }); continue }
      const s = this.sprite(`${d.kind}:${Math.floor(d.r * 4)}`, w, h, p => {
        switch (d.kind) {
          case 'tree': return drawTree(p, d.r)
          case 'bush': return drawBush(p, d.r)
          case 'rock': return drawRock(p, d.r)
          case 'flowers': return drawFlowers(p, d.r)
          case 'lamp': return drawLamp(p)
          case 'bench': return drawBench(p)
          case 'stall': return drawStall(p, d.r)
          case 'hay': return drawHay(p)
          case 'sign': return drawSignpost(p)
        }
      })
      items.push({ y: d.y * T, draw: () => c.drawImage(s.cv, dx, dy, w, h) })
    }
    for (const t of this.L.things) {
      const dim = !!focus && !focus.has(t.key)
      const bx = t.x * T, by = t.y * T, bw = t.w * T, bh = t.h * T
      const st = t.kind === 'agent' ? this.status.get(t.id) : null
      items.push({ y: by + bh, draw: () => {
        const s = this.buildingSprite(t)
        c.globalAlpha = dim ? 0.55 : 1
        c.drawImage(s.cv, bx, by - PAD, bw, bh + PAD)
        c.save(); c.translate(bx, by)
        const paint = new Paint(c, th)
        if (t.spec && s.anchors) drawHouseLive(paint, t.spec, s.anchors, now, st === 'busy')
        else drawLive(paint, t.style, t.color, now, false)
        if (t.kind === 'agent') {
          // a lantern by the door: dark while it sleeps, flickering as it wakes, lit while it's up
          const lx = (t.door[0] - t.x) * T + 9, ly = bh - 18
          c.fillStyle = css(th.dark); c.fillRect(lx, ly, 2, 14); c.fillRect(lx - 1, ly - 4, 4, 4)
          const awake = st === 'ready' || st === 'busy' || st === 'starting'
          if (awake) {
            const k = st === 'starting' ? (Math.sin(now / 60) > 0 ? 1 : 0.35) : 0.85 + 0.15 * Math.sin(now / 300)
            c.fillStyle = `rgba(255,214,110,${0.3 * k})`; c.beginPath(); c.arc(lx + 1, ly - 2, 7, 0, 7); c.fill()
            c.fillStyle = `rgba(255,226,140,${k})`; c.fillRect(lx, ly - 3, 2, 2)
          } else {                                              // asleep: z z z drifting off the roof
            for (let i = 0; i < 3; i++) {
              const ph = (now / 2400 + i / 3 + t.id * 0.37) % 1
              c.globalAlpha = (dim ? 0.3 : 0.75) * Math.sin(ph * Math.PI)
              c.fillStyle = '#f4ead2'; c.font = `700 ${7 + i}px ${th.style === 'soft' ? 'Georgia' : 'monospace'}`
              c.fillText('z', bw * 0.7 + ph * 10 + i * 3, -6 - ph * 16 - i * 4)
            }
            c.globalAlpha = dim ? 0.55 : 1
          }
        }
        if (t.kind === 'station' && t.status) {                      // the tool's status lamp
          const col = STATUS_COLOR[t.status], pulse = t.status === 'connected' ? 0.6 + 0.4 * Math.sin(now / 400) : 1
          c.fillStyle = css(th.dark); c.fillRect(bw - 5, bh - 20, 2, 16)
          c.fillStyle = css(col, 1, 0.35 * pulse); c.beginPath(); c.arc(bw - 4, bh - 22, 5, 0, 7); c.fill()
          c.fillStyle = css(col); c.fillRect(bw - 6, bh - 24, 4, 4)
        }
        if (this.selected === t.key) {
          c.strokeStyle = `rgba(255,217,143,${0.7 + 0.3 * Math.sin(now / 250)})`; c.lineWidth = 2
          c.strokeRect(-3, -PAD / 2, bw + 6, bh + PAD / 2 + 3)
        }
        c.restore(); c.globalAlpha = 1
      } })
      if (t.npc) {
        const w = this.walker(t)
        const walking = this.stepWalker(t, w, dt, st)
        const pose: NpcPose = { dir: w.dir, step: Math.floor(w.dist * 6), walking, bob: walking ? 0 : (Math.sin(now / 500 + t.id) > 0.6 ? 1 : 0) }
        items.push({ y: w.y * T, draw: () => {
          c.globalAlpha = dim ? 0.55 : 1
          this.drawPerson(c, w.x, w.y, { color: t.npc!.color, seed: t.npc!.seed, role: t.npc!.role }, pose)
          c.save(); c.translate(Math.round(w.x * T), Math.round(w.y * T))
          if (st === 'busy' || st === 'starting' || st === 'error' || st === 'ready') drawBubble(new Paint(c, th), st, now)
          if (this.selected === t.key) {
            const b = Math.round(Math.sin(now / 200) * 2)
            c.fillStyle = '#ffd98f'; c.beginPath(); c.moveTo(-4, -36 + b); c.lineTo(4, -36 + b); c.lineTo(0, -31 + b); c.fill()
          }
          c.restore(); c.globalAlpha = 1
        } })
      }
    }
    for (const cr of this.couriers) {
      const [x, y] = this.courierAt(cr)
      items.push({ y, draw: () => {
        c.save(); c.translate(Math.round(x), Math.round(y)); if (cr.dir < 0) c.scale(-1, 1)
        const p = new Paint(c, th)
        if (cr.vehicle === 'boat') drawBoat(p, cr.color, now)
        else if (cr.vehicle === 'cart') drawCart(p, cr.color, Math.floor(cr.dist / 5))
        else drawHorse(p, cr.color, Math.floor(cr.dist / 4))
        c.restore()
        if (cr.live) {                                         // on an errand right now: a sparkle trail
          c.fillStyle = `rgba(255,240,170,${0.5 + 0.5 * Math.sin(now / 90)})`
          c.fillRect(Math.round(x - cr.dir * 12), Math.round(y - 14), 2, 2)
        }
      } })
    }
    items.push({ y: pl.y * T, draw: () => this.drawPerson(c, pl.x, pl.y, { color: [230, 190, 70], seed: 3, role: 'player' },
      { dir: pl.dir, step: Math.floor(pl.dist * 5), walking: pl.moving, bob: 0 }) })
    if (pl.target) {
      const r = 3 + Math.sin(now / 150)
      c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = 1
      c.beginPath(); c.ellipse(pl.target[0] * T, pl.target[1] * T, r * 1.6, r * 0.8, 0, 0, 7); c.stroke()
    }
    items.sort((a, b) => a.y - b.y).forEach(i => i.draw())
    this.drawTrails(c, now)

    // names and prompts, in screen space so they stay readable at any zoom
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (th.style === 'soft') {                                       // painted light: warm centre, dark edges
      const g = c.createRadialGradient(innerWidth / 2, innerHeight * 0.45, innerHeight * 0.2, innerWidth / 2, innerHeight / 2, innerWidth * 0.75)
      g.addColorStop(0, 'rgba(255,214,150,0.10)'); g.addColorStop(1, 'rgba(10,8,24,0.55)')
      c.fillStyle = g; c.fillRect(0, 0, innerWidth, innerHeight)
    }
    const screen = (wx: number, wy: number): Pt => [this.view.x + wx * z, this.view.y + wy * z]
    for (const d of this.L.decor) if (d.kind === 'sign' && d.text) {
      const [sx, sy] = screen(d.x * T, d.y * T - 17)
      this.label(d.text, sx, sy, 12)
    }
    for (const t of this.L.things) {
      const sel = this.selected === t.key, dim = !!focus && !focus.has(t.key)
      if (t.npc) {                                                   // the name rides on the character
        const w = this.walkers.get(t.key)
        if (w) { const [sx, sy] = screen(w.x * T, w.y * T - 22); this.label(t.label, sx, sy, z < 1.2 ? 9 : 10, undefined, dim, sel) }
      } else {
        const [sx, sy] = screen((t.x + t.w / 2) * T, t.y * T - PAD / 2 + 4)
        this.label(t.label, sx, sy, z < 1.2 ? 9 : 11, z > 1.3 ? t.sub : undefined, dim, sel)
      }
    }
    const [px, py] = screen(pl.x * T, pl.y * T - 24)
    if (this.near) {
      const verb = this.near.kind === 'station' ? 'Visit' : this.near.kind === 'agent' || this.near.kind === 'shared' ? 'Talk to' : 'Open'
      this.label(`E · ${verb} ${this.near.label}`, px, py - 2, 12, undefined, false, true)
    } else this.label(this.playerName, px, py, z < 1.2 ? 9 : 10)

    if (this.cam) {
      this.view.x += (this.cam[0] - this.view.x) * 0.12
      this.view.y += (this.cam[1] - this.view.y) * 0.12
      if (!this.follow && Math.abs(this.cam[0] - this.view.x) + Math.abs(this.cam[1] - this.view.y) < 0.5) this.cam = null
    }
  }

  private drawPerson(c: CanvasRenderingContext2D, x: number, y: number, look: Parameters<typeof drawNpc>[1], pose: NpcPose) {
    const th = this.theme
    c.save(); c.translate(Math.round(x * T), Math.round(y * T))
    if (pose.dir < 0 && th.style !== 'soft') c.scale(-1, 1)
    drawNpc(new Paint(c, th, look.seed), look, { ...pose, dir: th.style !== 'soft' ? 1 : pose.dir })
    c.restore()
  }

  // ---------- picking & input ----------

  private toWorld(cx: number, cy: number): Pt { return [(cx - this.view.x) / this.view.zoom, (cy - this.view.y) / this.view.zoom] }

  pick(cx: number, cy: number): { thing: Thing; floor: string | null } | null {
    if (!this.L) return null
    const [px, py] = this.toWorld(cx, cy)
    for (const t of this.L.things) {                                  // NPCs first: they stand in front
      const w = t.npc && this.walkers.get(t.key)
      if (w && Math.abs(px - w.x * T) < 8 && py < w.y * T + 2 && py > w.y * T - 22) return { thing: t, floor: null }
    }
    const order = [...this.L.things].sort((a, b) => (b.y + b.h) - (a.y + a.h))
    for (const t of order) {
      if (px >= t.x * T && px <= (t.x + t.w) * T && py >= t.y * T - PAD / 2 && py <= (t.y + t.h) * T) return { thing: t, floor: null }
    }
    return null
  }

  private down = (e: PointerEvent) => {
    this.cam = null; this.follow = false
    this.drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false, id: e.pointerId }
  }

  private move = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.id) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true
      if (this.drag.moved) { this.view.x = this.drag.vx + dx; this.view.y = this.drag.vy + dy }
      return
    }
    if (e.target !== this.canvas) return
    this.canvas.style.cursor = this.pick(e.clientX, e.clientY) ? 'pointer' : 'grab'
  }

  private up = (e: PointerEvent) => {
    if (this.drag && !this.drag.moved && e.target === this.canvas && this.player) {
      const hit = this.pick(e.clientX, e.clientY)
      if (hit) { this.player.target = [hit.thing.door[0], hit.thing.door[1] + 0.2]; this.onSelect(hit.thing, null) }
      else { const [wx, wy] = this.toWorld(e.clientX, e.clientY); this.player.target = [wx / T, wy / T]; this.onSelect(null, null) }
    }
    this.drag = null
  }

  private wheel = (e: WheelEvent) => {
    e.preventDefault()
    this.cam = null; this.follow = false
    const z = Math.max(0.5, Math.min(6, this.view.zoom * Math.exp(-e.deltaY * 0.0015)))
    this.view.x = e.clientX - (e.clientX - this.view.x) * z / this.view.zoom
    this.view.y = e.clientY - (e.clientY - this.view.y) * z / this.view.zoom
    this.view.zoom = z
  }
}
