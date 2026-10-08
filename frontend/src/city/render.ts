// Draws a Layout on a canvas, isometrically, and says what's under the pointer.
// No framework: one requestAnimationFrame loop and a painter's sort by depth.

import { CELL, STATUS_COLOR, type District, type Layout, type RGB, type Thing } from './layout'

const TW = 64, TH = 32

const iso = (gx: number, gy: number, z = 0): [number, number] => [(gx - gy) * TW / 2, (gx + gy) * TH / 2 - z]
const rgb = (c: RGB, k = 1, a = 1) =>
  `rgba(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0},${a})`
const hash = (x: number, y: number) => {
  let h = x * 374761393 + y * 668265263
  h = (h ^ (h >> 13)) * 1274126177
  return ((h ^ (h >> 16)) >>> 0) / 4294967296
}

const GROUND: Record<District['kind'], RGB> = { utilities: [150, 150, 158], private: [140, 186, 112], public: [214, 200, 172] }
const LOT: Record<District['kind'], RGB> = { utilities: [128, 128, 136], private: [120, 168, 96], public: [196, 180, 150] }
const STREET: RGB = [168, 164, 170]
const WALL: RGB = [226, 214, 190]

type Pt = [number, number]

export class CityView {
  private ctx: CanvasRenderingContext2D
  private canvas: HTMLCanvasElement
  private L: Layout | null = null
  private view = { x: 0, y: 0, zoom: 1 }
  private selected: string | null = null
  private hoverFloor: string | null = null
  private drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null
  private raf = 0
  private trees: [number, number, number][] = []
  private bottomInset = 0
  private cam: Pt | null = null
  onSelect: (t: Thing | null, floor: string | null) => void = () => {}

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.resize()
    canvas.addEventListener('mousedown', this.down)
    window.addEventListener('mousemove', this.move)
    window.addEventListener('mouseup', this.up)
    canvas.addEventListener('wheel', this.wheel, { passive: false })
    window.addEventListener('resize', this.resize)
    this.raf = requestAnimationFrame(this.frame)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('mousemove', this.move)
    window.removeEventListener('mouseup', this.up)
    window.removeEventListener('resize', this.resize)
  }

  setLayout(L: Layout, refit: boolean) {
    const firstTime = !this.L
    this.L = L
    this.trees = []
    const [W, H] = L.grid
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
      if (L.districts.some(d => x >= d.x0 - 1 && x <= d.x0 + d.w && y >= d.y0 - 1 && y <= d.y0 + d.h)) continue
      if (hash(x, y) < 0.32) this.trees.push([x + 0.5, y + 0.5, hash(y, x)])
    }
    if (firstTime || refit) this.fit()
  }

  setSelected(key: string | null) { this.selected = key }
  setHoverFloor(path: string | null) { this.hoverFloor = path }
  setBottomInset(px: number) { this.bottomInset = px }

  /** Glide so this thing sits in the middle of the space above the card. */
  focusOn(key: string) {
    const t = this.L?.things.find(x => x.key === key)
    if (!t) return
    const [wx, wy] = iso(t.x + t.w / 2, t.y + t.d / 2, t.height / 2 + 20)
    const top = 70, bottom = innerHeight - this.bottomInset
    this.cam = [innerWidth / 2 - wx * this.view.zoom, (top + bottom) / 2 - wy * this.view.zoom]
  }

  fit = () => {
    if (!this.L) return
    const [W, H] = this.L.grid
    const pts = [iso(0, 0), iso(W, 0), iso(0, H), iso(W, H)]
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys) + 200
    const availH = innerHeight - 70 - this.bottomInset
    this.view.zoom = Math.min(1.6, (innerWidth - 40) / w, availH / h)
    this.view.x = (innerWidth - w * this.view.zoom) / 2 - Math.min(...xs) * this.view.zoom
    this.view.y = 70 + 200 * this.view.zoom - Math.min(...ys) * this.view.zoom
  }

  private resize = () => {
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = innerWidth * dpr
    this.canvas.height = innerHeight * dpr
  }

  // ---------- drawing ----------
  private poly(pts: Pt[], fill?: string, stroke?: string) {
    const c = this.ctx
    c.beginPath()
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)))
    c.closePath()
    if (fill) { c.fillStyle = fill; c.fill() }
    if (stroke) { c.strokeStyle = stroke; c.stroke() }
  }

  private tile(x: number, y: number, fill: string) {
    this.poly([iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], fill, 'rgba(0,0,0,0.04)')
  }

  private focus(): Set<string> | null {
    if (!this.selected || !this.L) return null
    const s = new Set([this.selected])
    for (const w of this.L.wires) {
      if (w.from.key === this.selected) s.add(w.to.key)
      if (w.to.key === this.selected) s.add(w.from.key)
    }
    return s
  }

  private drawGround() {
    const L = this.L!
    const [W, H] = L.grid
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1
      this.tile(x, y, edge ? 'rgb(64,128,196)' : rgb([92 + hash(x, y) * 12, 158 + hash(y, x) * 12, 76]))
    }
    for (const d of L.districts) {
      for (let x = d.x0; x < d.x0 + d.w; x++) for (let y = d.y0; y < d.y0 + d.h; y++) {
        const street = (x - d.x0) % CELL === 0 || (y - d.y0) % CELL === 0
        this.tile(x, y, rgb(street ? STREET : LOT[d.kind], street ? 1 : 0.98 + hash(x, y) * 0.04))
      }
      // the district's border: hedges for private, a kerb for the rest
      const c = this.ctx
      c.lineWidth = d.kind === 'private' ? 5 : 2
      c.strokeStyle = d.kind === 'private' ? 'rgb(52,112,52)' : rgb(GROUND[d.kind], 0.7)
      this.poly([iso(d.x0, d.y0), iso(d.x0 + d.w, d.y0), iso(d.x0 + d.w, d.y0 + d.h), iso(d.x0, d.y0 + d.h)], undefined,
        c.strokeStyle as string)
      c.lineWidth = 1
      for (const [ex, ey] of d.empty) this.drawLot(ex, ey, d.kind)
    }
  }

  private drawLot(x: number, y: number, kind: District['kind']) {
    const c = this.ctx
    const [sx, sy] = iso(x + 1.5, y + 1.5)
    c.fillStyle = 'rgb(120,86,52)'; c.fillRect(sx - 1.5, sy - 18, 3, 18)
    c.fillStyle = 'rgba(250,244,228,0.95)'; c.fillRect(sx - 20, sy - 28, 40, 12)
    c.fillStyle = 'rgb(110,90,60)'; c.font = '600 7.5px system-ui'; c.textAlign = 'center'
    c.fillText(kind === 'utilities' ? '+ MCP tool' : kind === 'private' ? '+ agent' : 'share here', sx, sy - 19.5)
  }

  private windows(b0: Pt, b1: Pt, z0: number, z1: number, color: string, n: number) {
    const h = z1 - z0
    if (h < 8) return
    for (let i = 0; i < n; i++) {
      const u0 = (i + 0.3) / n, u1 = (i + 0.7) / n
      const p0: Pt = [b0[0] + (b1[0] - b0[0]) * u0, b0[1] + (b1[1] - b0[1]) * u0]
      const p1: Pt = [b0[0] + (b1[0] - b0[0]) * u1, b0[1] + (b1[1] - b0[1]) * u1]
      const v0 = z0 + h * 0.3, v1 = z0 + h * 0.75
      this.poly([[p0[0], p0[1] - v0], [p1[0], p1[1] - v0], [p1[0], p1[1] - v1], [p0[0], p0[1] - v1]], color)
    }
  }

  private drawThing(t: Thing, focus: Set<string> | null, now: number) {
    const dim = focus && !focus.has(t.key) ? 0.5 : 1
    const { x, y, w, d } = t
    const L0 = iso(x, y + d), F0 = iso(x + w, y + d), R0 = iso(x + w, y)
    let z = 0
    t.floors.forEach((f, i) => {
      const hot = this.hoverFloor && this.hoverFloor === f.path && this.selected === t.key
      const c: RGB = t.kind === 'station' ? [176, 178, 186] : hot ? [255, 214, 120] : WALL
      const shade = (i % 2 ? 0.92 : 1) * dim
      const L1: Pt = [L0[0], L0[1] - z], F1: Pt = [F0[0], F0[1] - z], R1: Pt = [R0[0], R0[1] - z]
      this.poly([L1, F1, [F1[0], F1[1] - f.h], [L1[0], L1[1] - f.h]], rgb(c, 0.95 * shade))
      this.poly([F1, R1, [R1[0], R1[1] - f.h], [F1[0], F1[1] - f.h]], rgb(c, 0.75 * shade))
      this.ctx.strokeStyle = `rgba(80,60,40,${0.22 * dim})`
      this.ctx.beginPath(); this.ctx.moveTo(L1[0], L1[1]); this.ctx.lineTo(F1[0], F1[1]); this.ctx.lineTo(R1[0], R1[1]); this.ctx.stroke()
      if (t.kind !== 'station') {
        this.windows(L0, F0, z, z + f.h, rgb([98, 130, 172], dim), w * 2)
        this.windows(F0, R0, z, z + f.h, rgb([98, 130, 172], dim * 0.8), d * 2)
      }
      z += f.h
    })
    const top: Pt[] = [iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)]
    this.poly(top, rgb(t.roof, 1.05 * dim), `rgba(0,0,0,${0.15 * dim})`)
    const inset: Pt[] = [iso(x + 0.15, y + 0.15, z), iso(x + w - 0.15, y + 0.15, z), iso(x + w - 0.15, y + d - 0.15, z), iso(x + 0.15, y + d - 0.15, z)]
    this.poly(inset, rgb(t.roof, 0.88 * dim))
    const [cx, cy] = iso(x + w / 2, y + d / 2, z)
    const c = this.ctx

    if (t.kind === 'station') {
      // a chimney and a status lamp that pulses when connected
      c.fillStyle = rgb([96, 98, 108], dim); c.fillRect(cx + 6, cy - 22, 8, 22)
      const col = STATUS_COLOR[t.status ?? 'unknown']
      const pulse = t.status === 'connected' ? 0.6 + 0.4 * Math.sin(now / 400) : 1
      c.fillStyle = rgb(col, 1, 0.35 * pulse * dim); c.beginPath(); c.arc(cx - 8, cy - 8, 11, 0, Math.PI * 2); c.fill()
      c.fillStyle = rgb(col, dim); c.beginPath(); c.arc(cx - 8, cy - 8, 5.5, 0, Math.PI * 2); c.fill()
    } else if (t.kind === 'library') {
      c.fillStyle = rgb([250, 244, 228], dim); c.fillRect(cx - 14, cy - 16, 28, 12)
      c.fillStyle = rgb([120, 80, 50], dim); c.font = '700 8px system-ui'; c.textAlign = 'center'; c.fillText('BOOKS', cx, cy - 7)
    } else if (t.kind === 'shared' || t.sub === 'shared') {
      c.strokeStyle = rgb([60, 50, 40], dim); c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx, cy - 26); c.stroke()
      const wave = Math.sin(now / 300) * 2
      this.poly([[cx, cy - 26], [cx + 15, cy - 22 + wave], [cx, cy - 18]], rgb(t.roof, 1.1 * dim))
    }
    if (this.selected === t.key) {
      c.lineWidth = 2
      this.poly([L0, F0, R0, iso(x + w, y, z), iso(x, y, z), iso(x, y + d, z)], undefined, '#fff')
      c.lineWidth = 1
    }
  }

  private drawTree([x, y, r]: [number, number, number]) {
    const c = this.ctx
    const [sx, sy] = iso(x, y)
    c.fillStyle = 'rgba(0,0,0,0.14)'; c.beginPath(); c.ellipse(sx, sy, 10, 5, 0, 0, Math.PI * 2); c.fill()
    c.fillStyle = '#7a5232'; c.fillRect(sx - 2, sy - 12, 4, 12)
    const leaf: RGB = ([[60, 128, 58], [70, 140, 62], [52, 116, 52]] as RGB[])[Math.floor(r * 3)]
    c.fillStyle = rgb(leaf); c.beginPath(); c.arc(sx, sy - 18, 10 + r * 3, 0, Math.PI * 2); c.fill()
  }

  private drawWires(focus: Set<string> | null, now: number) {
    const c = this.ctx
    for (const w of this.L!.wires) {
      const lit = !focus || (focus.has(w.from.key) && focus.has(w.to.key))
      const a = iso(w.from.x + w.from.w / 2, w.from.y + w.from.d / 2, w.from.height + 4)
      const b = iso(w.to.x + w.to.w / 2, w.to.y + w.to.d / 2, w.to.height + 2)
      const mid: Pt = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 60]
      c.strokeStyle = rgb(STATUS_COLOR[w.status], 1, lit ? 0.9 : 0.25)
      c.lineWidth = lit ? 2.5 : 1.5
      c.setLineDash(w.status === 'connected' ? [10, 6] : [3, 6])
      c.lineDashOffset = w.status === 'connected' ? -now / 40 : 0
      c.beginPath(); c.moveTo(a[0], a[1]); c.quadraticCurveTo(mid[0], mid[1], b[0], b[1]); c.stroke()
    }
    c.setLineDash([]); c.lineWidth = 1
  }

  private label(text: string, sx: number, sy: number, bg: string, fg: string, size = 11, sub?: string) {
    const c = this.ctx
    c.font = `600 ${size}px system-ui, sans-serif`
    const w1 = c.measureText(text).width
    c.font = `500 ${size - 2}px system-ui, sans-serif`
    const w2 = sub ? c.measureText(sub).width : 0
    const w = Math.max(w1, w2) + 12, h = sub ? size * 2 + 6 : size + 7
    c.fillStyle = bg; c.beginPath(); c.roundRect(sx - w / 2, sy - h, w, h, 6); c.fill()
    c.textAlign = 'center'; c.fillStyle = fg
    c.font = `600 ${size}px system-ui, sans-serif`; c.fillText(text, sx, sy - (sub ? size + 1 : 4))
    if (sub) { c.font = `500 ${size - 2}px system-ui, sans-serif`; c.fillStyle = 'rgba(60,50,40,0.8)'; c.fillText(sub, sx, sy - 4) }
  }

  private frame = (now: number) => {
    const c = this.ctx
    const dpr = window.devicePixelRatio || 1
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.fillStyle = '#1f3f68'; c.fillRect(0, 0, this.canvas.width, this.canvas.height)
    if (this.L) {
      c.setTransform(this.view.zoom * dpr, 0, 0, this.view.zoom * dpr, this.view.x * dpr, this.view.y * dpr)
      const focus = this.focus()
      this.drawGround()
      const items: { d: number; draw: () => void }[] = []
      for (const t of this.L.things) items.push({ d: t.x + t.w + t.y + t.d - 0.5, draw: () => this.drawThing(t, focus, now) })
      for (const tr of this.trees) items.push({ d: tr[0] + tr[1], draw: () => this.drawTree(tr) })
      items.sort((a, b) => a.d - b.d).forEach(i => i.draw())
      this.drawWires(focus, now)
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      const screen = (p: Pt): Pt => [this.view.x + p[0] * this.view.zoom, this.view.y + p[1] * this.view.zoom]
      for (const d of this.L.districts) {
        const [sx, sy] = screen(iso(d.x0 + d.w, d.y0 + d.h + 1.2))
        this.label(d.label, sx, sy, d.kind === 'private' ? 'rgba(46,96,46,0.92)' : 'rgba(30,40,60,0.82)', '#fff', 13)
      }
      for (const t of this.L.things) {
        const [sx, sy] = screen(iso(t.x + t.w / 2, t.y + t.d / 2, t.height + (t.kind === 'shared' || t.sub === 'shared' ? 30 : t.kind === 'station' ? 26 : 8)))
        const dim = focus && !focus.has(t.key)
        this.label(t.label, sx, sy - 4, dim ? 'rgba(255,252,244,0.5)' : 'rgba(255,252,244,0.95)', dim ? '#888' : '#1d2330', 12, t.sub)
      }
    }
    if (this.cam) {
      this.view.x += (this.cam[0] - this.view.x) * 0.12
      this.view.y += (this.cam[1] - this.view.y) * 0.12
      if (Math.abs(this.cam[0] - this.view.x) + Math.abs(this.cam[1] - this.view.y) < 0.5) this.cam = null
    }
    this.raf = requestAnimationFrame(this.frame)
  }

  // ---------- picking & input ----------
  private toWorld(cx: number, cy: number): Pt { return [(cx - this.view.x) / this.view.zoom, (cy - this.view.y) / this.view.zoom] }

  pick(cx: number, cy: number): { thing: Thing; floor: string | null } | null {
    if (!this.L) return null
    const p = this.toWorld(cx, cy)
    const order = [...this.L.things].sort((a, b) => (b.x + b.y) - (a.x + a.y))
    for (const t of order) {
      const { x, y, w, d } = t, z = t.height + (t.kind === 'station' ? 24 : 0)
      const hull: Pt[] = [iso(x, y + d), iso(x + w, y + d), iso(x + w, y), iso(x + w, y, z), iso(x, y, z), iso(x, y + d, z)]
      if (inside(p, hull)) {
        const F0 = iso(x + w, y + d)
        const zHere = F0[1] - Math.abs(p[0] - F0[0]) / 2 - p[1]
        let acc = 0
        const floor = t.floors.find(f => { const hit = zHere >= acc && zHere < acc + f.h; acc += f.h; return hit })
        return { thing: t, floor: floor?.path || null }
      }
    }
    return null
  }

  private down = (e: MouseEvent) => { this.cam = null; this.drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false } }

  private move = (e: MouseEvent) => {
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true
      if (this.drag.moved) { this.view.x = this.drag.vx + dx; this.view.y = this.drag.vy + dy }
      return
    }
    if (e.target !== this.canvas) return
    this.canvas.style.cursor = this.pick(e.clientX, e.clientY) ? 'pointer' : 'grab'
  }

  private up = (e: MouseEvent) => {
    if (this.drag && !this.drag.moved && e.target === this.canvas) {
      const hit = this.pick(e.clientX, e.clientY)
      this.onSelect(hit?.thing ?? null, hit?.floor ?? null)
    }
    this.drag = null
  }

  private wheel = (e: WheelEvent) => {
    e.preventDefault()
    this.cam = null
    const z = Math.max(0.25, Math.min(3, this.view.zoom * Math.exp(-e.deltaY * 0.0015)))
    this.view.x = e.clientX - (e.clientX - this.view.x) * z / this.view.zoom
    this.view.y = e.clientY - (e.clientY - this.view.y) * z / this.view.zoom
    this.view.zoom = z
  }
}

function inside(pt: Pt, pts: Pt[]) {
  let c = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c
  }
  return c
}
