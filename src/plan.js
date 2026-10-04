// 户型图编辑器：载入一张平面图 → 标定比例 → 描墙 → 生成 3D。
// 数据模型（像素坐标）：
//   walls: [{ ax, az, bx, bz, t, openings: [{ type, c, w, sill?, head? }] }]
//   t / c / w 都是像素；生成时统一除以 ppm 变米。
import { $, $$, toast, clamp, b64encode, b64decode, isTouch } from './util.js'
import { sampleAsPixels } from './sample.js'

const DEFAULT_PPM = 56 // 每米像素，用户标定后会改
const MIN_WALL_PX = 12

export class PlanEditor {
  constructor(app) {
    this.app = app
    this.canvas = $('#plan-canvas')
    this.ctx = this.canvas.getContext('2d')
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)

    this.walls = []
    this.rooms = [] // 房间标注 [{name, x, z, w, d}]
    this.pending = null // 正在拉的那一段
    this.tool = 'wall'
    this.snap = true
    this.snapTol = 14 // 像素
    this.ppm = DEFAULT_PPM
    this.calibrated = false
    this.calib = null // { a:{x,z}, b:{x,z}, meters }
    this.image = null
    this.imgScale = 1
    this.imgOffset = { x: 0, z: 0 }
    this.view = { x: 0, z: 0, k: 1 } // 画布平移缩放（像素坐标系）
    this.history = []
    this.doorWidth = 0.9 * DEFAULT_PPM
    this.wallThickness = 0.12 * DEFAULT_PPM
    this.wallHeight = 2.8
    this.makeFloor = true
    this.onChange = null
    this.onClose = null
    this._drag = null
    this.hoverWall = null // 当前悬停的墙下标（null = 没命中）
    this._bind()
  }

  /* ───────── 视图 ───────── */

  fitView() {
    const r = this.canvas.getBoundingClientRect()
    const pts = []
    for (const w of this.walls) pts.push([w.ax, w.az], [w.bx, w.bz])
    if (this.image) {
      pts.push([this.imgOffset.x, this.imgOffset.z])
      pts.push([this.imgOffset.x + this.image.width * this.imgScale, this.imgOffset.z + this.image.height * this.imgScale])
    }
    if (!pts.length) {
      this.view = { x: 0, z: 0, k: 1 }
      return
    }
    const xs = pts.map((p) => p[0])
    const zs = pts.map((p) => p[1])
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minZ = Math.min(...zs)
    const maxZ = Math.max(...zs)
    const pad = 60
    const k = Math.min(
      (r.width - pad * 2) / Math.max(1, maxX - minX),
      (r.height - pad * 2) / Math.max(1, maxZ - minZ),
      4
    )
    this.view.k = clamp(k, 0.05, 8)
    this.view.x = (minX + maxX) / 2
    this.view.z = (minZ + maxZ) / 2
  }

  toScreen(x, z) {
    const r = this.canvas.getBoundingClientRect()
    return [
      r.width / 2 + (x - this.view.x) * this.view.k,
      r.height / 2 + (z - this.view.z) * this.view.k,
    ]
  }

  toWorld(sx, sy) {
    const r = this.canvas.getBoundingClientRect()
    return {
      x: (sx - r.width / 2) / this.view.k + this.view.x,
      z: (sy - r.height / 2) / this.view.k + this.view.z,
    }
  }

  /* ───────── 交互 ───────── */

  _bind() {
    const c = this.canvas

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture?.(e.pointerId)
      const r = c.getBoundingClientRect()
      const p = this.toWorld(e.clientX - r.left, e.clientY - r.top)

      if (this.tool === 'pan' || e.button === 1 || e.shiftKey) {
        this._drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vz: this.view.z }
        return
      }

      if (this.tool === 'calibrate') {
        if (!this.calib) this.calib = { a: p, b: null, meters: 3 }
        else if (!this.calib.b) this.calib.b = p
        this.draw()
        return
      }

      if (this.tool === 'erase') {
        const hit = this.hitWall(p, 12 / this.view.k)
        if (hit !== null) {
          this.push()
          this.walls.splice(hit, 1)
          this._changed()
        }
        return
      }

      if (this.tool === 'door') return // 门洞在 main.js 的 click 里处理，这里不要起墙拖拽

      // 画墙 / 开门洞：按下起点，拖动拉出终点
      const s = this.snapPoint(p)
      this.pending = { ax: s.x, az: s.z, bx: p.x, bz: p.z, t: this.wallThickness, openings: [] }
      this._drag = { kind: 'draw', pointerId: e.pointerId }
      this.draw()
    })

    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect()
      const p = this.toWorld(e.clientX - r.left, e.clientY - r.top)

      if (this._drag?.kind === 'pan') {
        this.view.x = this._drag.vx - (e.clientX - this._drag.sx) / this.view.k
        this.view.z = this._drag.vz - (e.clientY - this._drag.sy) / this.view.k
        this.draw()
        return
      }

      if (this._drag?.kind === 'draw' && this.pending) {
        const s = this.snapPoint(p, this.pending.ax, this.pending.az)
        // 靠近水平/垂直时强制正交，描出来的墙更整齐
        const dx = s.x - this.pending.ax
        const dz = s.z - this.pending.az
        const tol = 8 / this.view.k
        if (Math.abs(dz) < tol) {
          this.pending.bx = s.x
          this.pending.bz = this.pending.az
        } else if (Math.abs(dx) < tol) {
          this.pending.bx = this.pending.ax
          this.pending.bz = s.z
        } else {
          this.pending.bx = s.x
          this.pending.bz = s.z
        }
        this.draw()
        return
      }

      if (this._drag?.kind === 'open' && this._openState) {
        this._openState.c = this._distOn(this.walls[this._openState.i], p)
        this.draw()
        return
      }

      this.hover = p
      // 悬停高亮：0 是合法下标，所以用 null 表示没有命中
      this.hoverWall = this.hitWall(p, 12 / this.view.k)
      this.draw()
    })

    const end = (e) => {
      if (this._drag?.kind === 'draw' && this.pending) {
        const len = Math.hypot(this.pending.bx - this.pending.ax, this.pending.bz - this.pending.az)
        if (len >= MIN_WALL_PX) {
          // 正交吸附的收尾
          const t = clamp(this.wallThickness, 4, 60)
          this.push()
          this.walls.push({
            ax: this.pending.ax,
            az: this.pending.az,
            bx: this.pending.bx,
            bz: this.pending.bz,
            t,
            openings: [],
          })
          this.mergeCollinear()
          this._changed()
        }
      }
      this.pending = null
      this._drag = null
      this._openState = null
      this.draw()
      void e
    }
    c.addEventListener('pointerup', end)
    c.addEventListener('pointercancel', end)

    c.addEventListener('wheel', (e) => {
      e.preventDefault()
      const r = c.getBoundingClientRect()
      const before = this.toWorld(e.clientX - r.left, e.clientY - r.top)
      const k = clamp(this.view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.04, 12)
      this.view.k = k
      const after = this.toWorld(e.clientX - r.left, e.clientY - r.top)
      this.view.x += before.x - after.x
      this.view.z += before.z - after.z
      this.draw()
    }, { passive: false })

    window.addEventListener('keydown', (e) => {
      if ($('#plan-editor').hidden) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        this.pending = null
        if (this.tool === 'calibrate') this.calib = null
        this.draw()
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        this.undo()
      }
      if (e.key === '1') this.setTool('wall')
      if (e.key === '2') this.setTool('door')
      if (e.key === '3') this.setTool('erase')
      if (e.key === '4') this.setTool('pan')
      if (e.key === '5') this.setTool('calibrate')
    })
  }

  snapPoint(p, fromX, fromZ) {
    if (!this.snap) return p
    let best = null
    let bestD = this.snapTol / this.view.k
    for (const w of this.walls) {
      for (const [x, z] of [
        [w.ax, w.az],
        [w.bx, w.bz],
      ]) {
        if (fromX !== undefined && Math.abs(x - fromX) < 1e-6 && Math.abs(z - fromZ) < 1e-6) continue
        const d = Math.hypot(x - p.x, z - p.z)
        if (d < bestD) {
          bestD = d
          best = { x, z }
        }
      }
      // 吸附到墙线上（垂足）
      const len2 = (w.bx - w.ax) ** 2 + (w.bz - w.az) ** 2
      if (len2 > 1e-6) {
        let t = ((p.x - w.ax) * (w.bx - w.ax) + (p.z - w.az) * (w.bz - w.az)) / len2
        t = clamp(t, 0, 1)
        const fx = w.ax + (w.bx - w.ax) * t
        const fz = w.az + (w.bz - w.az) * t
        const d = Math.hypot(fx - p.x, fz - p.z)
        if (d < bestD) {
          bestD = d
          best = { x: fx, z: fz }
        }
      }
    }
    return best || p
  }

  hitWall(p, tol) {
    let best = -1
    let bestD = tol
    for (let i = 0; i < this.walls.length; i++) {
      const w = this.walls[i]
      const len2 = (w.bx - w.ax) ** 2 + (w.bz - w.az) ** 2
      if (len2 < 1e-6) continue
      let t = ((p.x - w.ax) * (w.bx - w.ax) + (p.z - w.az) * (w.bz - w.az)) / len2
      t = clamp(t, 0, 1)
      const fx = w.ax + (w.bx - w.ax) * t
      const fz = w.az + (w.bz - w.az) * t
      const d = Math.hypot(fx - p.x, fz - p.z) - (w.t || 10) / 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best >= 0 ? best : null
  }

  _distOn(w, p) {
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1
    const ux = (w.bx - w.ax) / len
    const uz = (w.bz - w.az) / len
    return clamp((p.x - w.ax) * ux + (p.z - w.az) * uz, 0, len)
  }

  /** 同一条线上的墙段合并，避免描线时碎成很多小段 */
  mergeCollinear() {
    const eps = 0.5
    const out = []
    const used = new Array(this.walls.length).fill(false)
    const norm = (w) => {
      const horizontal = Math.abs(w.bz - w.az) < Math.abs(w.bx - w.ax)
      return { horizontal, key: horizontal ? Math.round(w.az / 2) * 2 : Math.round(w.ax / 2) * 2 }
    }
    // opening.c 是「从 A 端沿墙量过去的距离」，属于每段墙自己的相对坐标系。
    // 合并后 A 会挪到新的最小端，所以必须先把每个洞还原成绝对坐标，再按新 A 重新投影，
    // 否则门窗会整体串位（甚至被裁掉）。
    const absOf = (w, o, horiz) => {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1
      const ux = (w.bx - w.ax) / len
      const uz = (w.bz - w.az) / len
      return horiz ? w.ax + o.c * ux : w.az + o.c * uz
    }
    const rebaseOpenings = (horiz, a, b, base, span) => {
      const merged = []
      for (const w of [a, b]) {
        for (const o of w.openings || []) {
          const c = absOf(w, o, horiz) - base
          if (c >= 0 && c <= span) merged.push({ ...o, c })
        }
      }
      merged.sort((x, y) => x.c - y.c)
      return merged
    }
    for (let i = 0; i < this.walls.length; i++) {
      if (used[i]) continue
      let cur = { ...this.walls[i] }
      const { horizontal, key } = norm(cur)
      for (let j = i + 1; j < this.walls.length; j++) {
        if (used[j]) continue
        const o = this.walls[j]
        const n2 = norm(o)
        if (n2.horizontal !== horizontal || Math.abs(n2.key - key) > eps) continue
        if (Math.abs((o.t || 10) - (cur.t || 10)) > eps) continue
        // 只在端点相接时合并
        const ends = [
          [cur.ax, cur.az],
          [cur.bx, cur.bz],
        ]
        const oends = [
          [o.ax, o.az],
          [o.bx, o.bz],
        ]
        const touch = ends.some(([x1, z1]) =>
          oends.some(([x2, z2]) => Math.hypot(x1 - x2, z1 - z2) < eps * 4)
        )
        if (!touch) continue
        if (horizontal) {
          const xs = [cur.ax, cur.bx, o.ax, o.bx]
          const nax = Math.min(...xs)
          const nbx = Math.max(...xs)
          const merged = rebaseOpenings(true, cur, o, nax, nbx - nax)
          cur = { ...cur, ax: nax, bx: nbx, az: key, bz: key, openings: merged }
        } else {
          const zs = [cur.az, cur.bz, o.az, o.bz]
          const naz = Math.min(...zs)
          const nbz = Math.max(...zs)
          const merged = rebaseOpenings(false, cur, o, naz, nbz - naz)
          cur = { ...cur, az: naz, bz: nbz, ax: key, bx: key, openings: merged }
        }
        used[j] = true
      }
      used[i] = true
      out.push(cur)
    }
    this.walls = out
  }

  push() {
    this.history.push(JSON.stringify(this.walls))
    if (this.history.length > 60) this.history.shift()
  }

  undo() {
    const s = this.history.pop()
    if (!s) return
    try {
      this.walls = JSON.parse(s)
    } catch {
      /* 忽略坏数据 */
    }
    this._changed()
  }

  _changed() {
    this.updateStats()
    this.onChange?.(this.stats())
    this.draw()
  }

  setTool(t) {
    this.tool = t
    if (t !== 'calibrate') this.calib = null
    $$('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t))
    this.canvas.style.cursor = t === 'pan' ? 'grab' : t === 'erase' ? 'not-allowed' : 'crosshair'
    this.updateHud()
    this.draw()
  }

  /* ───────── 图片 ───────── */

  async loadImageFile(file) {
    const url = URL.createObjectURL(file)
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = () => rej(new Error('图片读取失败'))
        i.src = url
      })
      this.image = img
      // 初始按 1 像素 = 1 单位摆放
      this.imgScale = 1
      this.imgOffset = { x: 0, z: 0 }
      this.fitView()
      toast(`已载入平面图 ${img.width}×${img.height}`)
      this.draw()
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  clearImage() {
    this.image = null
    this.draw()
  }

  /* ───────── 绘制 ───────── */

  resize() {
    const r = this.canvas.getBoundingClientRect()
    const w = Math.max(64, Math.round(r.width))
    const h = Math.max(64, Math.round(r.height))
    if (this.canvas.width !== w * this.dpr || this.canvas.height !== h * this.dpr) {
      this.canvas.width = w * this.dpr
      this.canvas.height = h * this.dpr
    }
    return { w, h }
  }

  draw() {
    const { w, h } = this.resize()
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // 底图
    if (this.image) {
      const [ix, iy] = this.toScreen(this.imgOffset.x, this.imgOffset.z)
      const iw = this.image.width * this.imgScale * this.view.k
      const ih = this.image.height * this.imgScale * this.view.k
      ctx.globalAlpha = 0.9
      ctx.drawImage(this.image, ix, iy, iw, ih)
      ctx.globalAlpha = 1
    }

    // 墙
    for (let i = 0; i < this.walls.length; i++) {
      this._drawWall(ctx, this.walls[i], i === this.hoverWall)
    }

    // 正在拉的
    if (this.pending) {
      const len = Math.hypot(this.pending.bx - this.pending.ax, this.pending.bz - this.pending.az)
      ctx.strokeStyle = '#4f8bff'
      ctx.lineWidth = Math.max(2, this.pending.t * this.view.k)
      ctx.setLineDash([6, 4])
      this._line(ctx, this.pending.ax, this.pending.az, this.pending.bx, this.pending.bz)
      ctx.setLineDash([])
      // 长度标注
      const [mx, my] = this.toScreen((this.pending.ax + this.pending.bx) / 2, (this.pending.az + this.pending.bz) / 2)
      const meters = len / this.ppm
      this._label(ctx, mx, my - 14, `${meters.toFixed(2)} m`)
    }

    // 标定
    if (this.calib) {
      const { a, b, meters } = this.calib
      ctx.strokeStyle = '#ffb648'
      ctx.lineWidth = 2
      ctx.setLineDash([5, 5])
      if (a) this._dot(ctx, a.x, a.z, '#ffb648')
      if (b) {
        this._line(ctx, a.x, a.z, b.x, b.z)
        this._dot(ctx, b.x, b.z, '#ffb648')
        const px = Math.hypot(b.x - a.x, b.z - a.z)
        const [mx, my] = this.toScreen((a.x + b.x) / 2, (a.z + b.z) / 2)
        this._label(ctx, mx, my - 18, `这段 ${meters} m → ${(px / meters).toFixed(1)} px/m`)
      }
      ctx.setLineDash([])
    }

    if (!this.walls.length && !this.image) {
      ctx.fillStyle = 'rgba(150,165,185,0.5)'
      ctx.font = '13px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('载入一张平面图，或直接用示例户型开始描墙', w / 2, h / 2)
    }
  }

  _drawWall(ctx, w, highlight = false) {
    const t = Math.max(3, (w.t || 10) * this.view.k)
    const [ax, ay] = this.toScreen(w.ax, w.az)
    const [bx, by] = this.toScreen(w.bx, w.bz)

    ctx.lineCap = 'butt'
    ctx.strokeStyle = highlight ? '#ff8b6e' : '#dfe8f5'
    ctx.lineWidth = t
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()

    // 门洞：用画布底色划掉一段
    for (const o of w.openings || []) {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1
      const ux = (w.bx - w.ax) / len
      const uz = (w.bz - w.az) / len
      const cx = w.ax + ux * o.c
      const cz = w.az + uz * o.c
      const half = o.w / 2
      const [x1, y1] = this.toScreen(cx - ux * half, cz - uz * half)
      const [x2, y2] = this.toScreen(cx + ux * half, cz + uz * half)

      ctx.strokeStyle = '#7d8899'
      ctx.lineWidth = Math.max(2, t + 2)
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()

      ctx.strokeStyle = '#0a0d11'
      ctx.lineWidth = Math.max(1.5, t)
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()

      // 开门弧线
      if (o.type === 'door') {
        ctx.strokeStyle = 'rgba(120,180,255,0.55)'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc(x1, y1, Math.hypot(x2 - x1, y2 - y1), Math.atan2(y2 - y1, x2 - x1), Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2)
        ctx.stroke()
      }
    }

    // 端点手柄
    ctx.fillStyle = highlight ? '#ff8b6e' : '#8fb2ff'
    for (const [x, y] of [
      [ax, ay],
      [bx, by],
    ]) {
      ctx.beginPath()
      ctx.arc(x, y, 3.2, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  _line(ctx, ax, az, bx, bz) {
    const [x1, y1] = this.toScreen(ax, az)
    const [x2, y2] = this.toScreen(bx, bz)
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  _dot(ctx, x, z, color) {
    const [sx, sy] = this.toScreen(x, z)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(sx, sy, 5, 0, Math.PI * 2)
    ctx.fill()
  }

  _label(ctx, x, y, text) {
    ctx.font = '12px system-ui, sans-serif'
    ctx.textAlign = 'center'
    const w = ctx.measureText(text).width + 14
    ctx.fillStyle = 'rgba(10,14,20,0.85)'
    ctx.beginPath()
    if (ctx.roundRect) {
      ctx.roundRect(x - w / 2, y - 11, w, 20, 6)
    } else {
      ctx.rect(x - w / 2, y - 11, w, 20)
    }
    ctx.fill()
    ctx.fillStyle = '#cfe0ff'
    ctx.fillText(text, x, y + 3)
  }

  /* ───────── 统计 / HUD ───────── */

  stats() {
    let totalPx = 0
    let doors = 0
    let windows = 0
    for (const w of this.walls) {
      totalPx += Math.hypot(w.bx - w.ax, w.bz - w.az)
      for (const o of w.openings || []) {
        if (o.type === 'door') doors++
        else windows++
      }
    }
    const totalM = totalPx / this.ppm
    const xs = this.walls.flatMap((w) => [w.ax, w.bx])
    const zs = this.walls.flatMap((w) => [w.az, w.bz])
    const w = this.walls.length ? (Math.max(...xs) - Math.min(...xs)) / this.ppm : 0
    const d = this.walls.length ? (Math.max(...zs) - Math.min(...zs)) / this.ppm : 0
    return { walls: this.walls.length, doors, windows, totalM, w, d }
  }

  updateStats() {
    const s = this.stats()
    const el = $('#pe-stat')
    if (el) {
      el.textContent = `墙段 ${s.walls} · 门洞 ${s.doors} · 窗 ${s.windows} · 总长 ${s.totalM.toFixed(1)} m · 约 ${s.w.toFixed(1)}×${s.d.toFixed(1)} m`
    }
    const steps = $$('.pe-steps li')
    const has = (i, on) => steps[i]?.classList.toggle('done', on)
    if (steps.length >= 4) {
      has(0, !!this.image)
      has(1, this.calibrated)
      has(2, this.walls.length > 0)
      has(3, false)
      const nowIdx = this.walls.length ? 3 : this.calibrated ? 2 : this.image ? 1 : 0
      steps.forEach((li, i) => li.classList.toggle('now', i === nowIdx))
    }
    const gen = $('[data-pe="build"]')
    if (gen) gen.disabled = !this.walls.length
  }

  updateHud() {
    const el = $('#pe-hud')
    if (!el) return
    const tips = {
      wall: '拖动描一段墙 · 靠近已有端点会自动吸附 · 按住 Shift 平移画面',
      door: '在墙上点一下开一个门洞 · Ctrl+Z 撤销',
      erase: '点墙上任意位置删除整段墙',
      pan: '拖动平移 · 滚轮缩放',
      calibrate: '点两处已知距离，然后在右侧填入实际米数',
    }
    el.textContent = tips[this.tool] || ''
  }

  /* ───────── 输出 ───────── */

  /** 导出为米制墙段，交给 3D 生成 */
  toWalls() {
    const s = 1 / this.ppm
    return this.walls
      .map((w) => ({
        ax: w.ax * s,
        az: w.az * s,
        bx: w.bx * s,
        bz: w.bz * s,
        t: Math.max(0.06, (w.t || this.wallThickness) * s),
        openings: (w.openings || []).map((o) => ({
          type: o.type,
          c: o.c * s,
          w: o.w * s,
          sill: o.sill,
          head: o.head,
        })),
      }))
      .filter((w) => Math.hypot(w.bx - w.ax, w.bz - w.az) > 0.2)
  }

  loadWalls(wallsInPixels) {
    this.walls = wallsInPixels.map((w) => ({ ...w, openings: (w.openings || []).map((o) => ({ ...o })) }))
    this.history = []
    this.fitView()
    this._changed()
  }

  /** 存成可分享的紧凑结构 */
  serialize() {
    return {
      v: 1,
      ppm: Math.round(this.ppm * 100) / 100,
      t: Math.round(this.wallThickness * 100) / 100,
      h: this.wallHeight,
      walls: this.walls.map((w) => ({
        a: [Math.round(w.ax), Math.round(w.az)],
        b: [Math.round(w.bx), Math.round(w.bz)],
        t: Math.round(w.t || this.wallThickness),
        o: (w.openings || []).map((o) => ({
          y: o.type === 'window' ? 1 : 0,
          c: Math.round(o.c),
          w: Math.round(o.w),
          s: o.sill,
          h: o.head,
        })),
      })),
    }
  }

  /**
   * 从分享链接还原。链接是任何人都能改的，所以每个数都要校验：
   * 不是有效数字就丢弃，超出合理范围就钳住，墙段数量封顶。
   */
  // data 既可能是已解码的 JSON 字符串（handleDeepLink 传来），也可能是对象。
  // 注意：调用方已经做过 b64decode，这里不要再解一次。
  static deserialize(data) {
    const o = typeof data === 'string' ? JSON.parse(data) : data
    if (!o || typeof o !== 'object') throw new Error('户型数据格式不对')

    const num = (v, lo, hi) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null
    }
    const COORD = 200000 // 像素坐标上限；按 56 px/m 算约 3.5 公里，任何户型都够
    const MAX_WALLS = 5000
    const MAX_OPENINGS = 64

    const ppm = num(o.ppm, 1, 5000) ?? DEFAULT_PPM
    const wallThickness = num(o.t, 1, 200) ?? 0.12 * ppm
    const wallHeight = num(o.h, 1.5, 6) ?? 2.8

    const walls = []
    const list = Array.isArray(o.walls) ? o.walls.slice(0, MAX_WALLS) : []
    for (const w of list) {
      if (!w || !Array.isArray(w.a) || !Array.isArray(w.b)) continue
      const ax = num(w.a[0], -COORD, COORD)
      const az = num(w.a[1], -COORD, COORD)
      const bx = num(w.b[0], -COORD, COORD)
      const bz = num(w.b[1], -COORD, COORD)
      if (ax === null || az === null || bx === null || bz === null) continue
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 1) continue

      const openings = []
      for (const x of Array.isArray(w.o) ? w.o.slice(0, MAX_OPENINGS) : []) {
        if (!x) continue
        const c = num(x.c, 0, len)
        const ow = num(x.w, 1, len)
        if (c === null || ow === null) continue
        openings.push({
          type: x.y ? 'window' : 'door',
          c,
          w: ow,
          sill: num(x.s, 0, 3) ?? undefined,
          head: num(x.h, 0.5, 6) ?? undefined,
        })
      }
      walls.push({ ax, az, bx, bz, t: num(w.t, 1, 200) ?? wallThickness, openings })
    }

    return { ppm, wallThickness, wallHeight, walls }
  }

  /** 生成分享用字符串（含图片会很大，所以只存墙） */
  toShareString() {
    return b64encode(JSON.stringify(this.serialize()))
  }

  loadDemo() {
    this.ppm = DEFAULT_PPM
    this.calibrated = true
    this.wallThickness = 0.14 * DEFAULT_PPM
    this.loadWalls(sampleAsPixels(DEFAULT_PPM))
    this.setTool('pan')
    this.view.k = 0.7
    this.fitView()
    this.draw()
    toast('已载入示例户型，直接点「生成 3D 空间」即可')
  }

  /** 把墙段渲染成一张平面图 PNG（没有原图时用） */
  async makeFallbackImage() {
    const walls = this.walls
    if (!walls.length) return null
    const { floorPlanSheet } = await import('./textures.js')
    const s = 1 / this.ppm
    const meters = walls.map((w) => ({
      ax: w.ax * s, az: w.az * s, bx: w.bx * s, bz: w.bz * s, t: (w.t || 10) * s,
      openings: (w.openings || []).map((o) => ({ ...o, c: o.c * s, w: o.w * s })),
    }))
    const { canvas } = floorPlanSheet(meters, { size: 1400 })
    return canvas
  }
}
