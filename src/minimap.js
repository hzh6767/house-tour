// 小地图 / 户型缩略图。左边是俯视墙体，上面一个点表示你在哪、朝哪看。
// 两种数据源都能画：导入模型烘出来的栅格(wallGrid)，或户型图编辑器的墙段(walls)。

const DEG = 180 / Math.PI

export class Minimap {
  constructor(canvas, opts = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.plan = null
    this.rotation = 0 // 0 = 正北朝上
    this.rotateWithPlayer = opts.rotateWithPlayer ?? false
    this.padding = 16
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.onPick = null
    this._view = null
    this._rotUsed = 0
    this._bind()
  }

  _bind() {
    this.canvas.addEventListener('click', (e) => {
      if (!this.plan || !this.onPick) return
      const r = this.canvas.getBoundingClientRect()
      const p = this.screenToWorld(e.clientX - r.left, e.clientY - r.top)
      if (p) this.onPick(p)
    })
    this.canvas.style.cursor = 'crosshair'
  }

  setPlan(plan) {
    this.plan = plan
    this._view = null
  }

  resize() {
    const r = this.canvas.getBoundingClientRect()
    const w = Math.max(64, Math.round(r.width))
    const h = Math.max(64, Math.round(r.height))
    if (this.canvas.width !== w * this.dpr || this.canvas.height !== h * this.dpr) {
      this.canvas.width = w * this.dpr
      this.canvas.height = h * this.dpr
      this._view = null
    }
    return { w, h }
  }

  _computeView(w, h) {
    const b = this.plan.bounds
    const spanX = Math.max(b.maxX - b.minX, 0.001)
    const spanZ = Math.max(b.maxZ - b.minZ, 0.001)
    const span = Math.max(spanX, spanZ)
    const k = (Math.min(w, h) - this.padding * 2) / span
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2
    this._view = { k, cx, cz, w, h }
  }

  worldToScreen(x, z, rot = 0) {
    const v = this._view
    if (!v) return [0, 0]
    const dx = x - v.cx
    const dz = z - v.cz
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const rx = dx * c - dz * s
    const rz = dx * s + dz * c
    return [v.w / 2 + rx * v.k, v.h / 2 + rz * v.k]
  }

  screenToWorld(px, py) {
    const v = this._view
    if (!v) return null
    const rot = this._rotUsed || 0
    const c = Math.cos(-rot)
    const s = Math.sin(-rot)
    let rx = (px - v.w / 2) / v.k
    let rz = (py - v.h / 2) / v.k
    const dx = rx * c - rz * s
    const dz = rx * s + rz * c
    return { x: v.cx + dx, z: v.cz + dz }
  }

  /**
   * @param {{x:number,z:number}} playerPos 脚底坐标
   * @param {number} yaw 玩家朝向（弧度，0 = 朝 -Z）
   */
  draw(playerPos, yaw, opts = {}) {
    const { w, h } = this.resize()
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    if (!this.plan) {
      this._drawEmpty(w, h)
      return
    }

    const rot = this.rotateWithPlayer || opts.rotate ? -yaw - Math.PI / 2 : 0
    this._rotUsed = rot
    if (!this._view || this._view.w !== w || this._view.h !== h) this._computeView(w, h)

    // 背景
    ctx.fillStyle = 'rgba(8,12,17,0.55)'
    ctx.fillRect(0, 0, w, h)

    this._drawWalls(ctx, rot)

    // 玩家
    const [px, py] = this.worldToScreen(playerPos.x, playerPos.z, rot)
    const dirX = -Math.sin(yaw)
    const dirZ = -Math.cos(yaw)
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const ang = Math.atan2(dirX * s + dirZ * c, dirX * c - dirZ * s)

    // 视野扇形
    const fov = (opts.fov || 72) / DEG
    const rCone = Math.min(w, h) * 0.22
    const grad = ctx.createRadialGradient(px, py, 0, px, py, rCone)
    grad.addColorStop(0, 'rgba(110,160,255,0.55)')
    grad.addColorStop(1, 'rgba(110,160,255,0)')
    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.arc(px, py, rCone, ang - fov / 2, ang + fov / 2)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    // 点
    ctx.beginPath()
    ctx.arc(px, py, 5.5, 0, Math.PI * 2)
    ctx.fillStyle = '#4f8bff'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#fff'
    ctx.stroke()

    // 指北针
    ctx.save()
    ctx.translate(w - 20, 20)
    ctx.rotate(-rot)
    ctx.fillStyle = 'rgba(255,255,255,0.65)'
    ctx.beginPath()
    ctx.moveTo(0, -8)
    ctx.lineTo(4.5, 6)
    ctx.lineTo(0, 3)
    ctx.lineTo(-4.5, 6)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    // 比例尺
    if (this._view) {
      const meters = niceScale((w * 0.42) / this._view.k)
      const px2 = meters * this._view.k
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(14, h - 16)
      ctx.lineTo(14 + px2, h - 16)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(14, h - 20)
      ctx.lineTo(14, h - 12)
      ctx.moveTo(14 + px2, h - 20)
      ctx.lineTo(14 + px2, h - 12)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,0.62)'
      ctx.font = '10px system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`${meters} m`, 14, h - 22)
    }
  }

  _drawEmpty(w, h) {
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(12,16,22,0.6)'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(150,165,185,0.55)'
    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('暂无平面数据', w / 2, h / 2 + 4)
  }

  _drawWalls(ctx, rot) {
    const plan = this.plan
    const v = this._view
    if (!v) return

    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    // 1) 栅格（导入的模型）
    if (plan.wallGrid) {
      const g = plan.wallGrid
      const cell = g.cell
      const size = Math.max(1, cell * v.k)
      const b = plan.bounds
      ctx.fillStyle = 'rgba(214,228,246,0.82)'
      // 只在有墙的格子上画方块
      for (let gy = 0; gy < g.h; gy++) {
        for (let gx = 0; gx < g.w; gx++) {
          if (!g.data || !g.data[gy * g.w + gx]) continue
          const wx = b.minX + gx * cell
          const wz = b.minZ + gy * cell
          const [sx, sy] = this.worldToScreen(wx, wz, rot)
          if (sx < -size || sy < -size || sx > v.w + size || sy > v.h + size) continue
          ctx.fillRect(sx - size / 2, sy - size / 2, size + 0.5, size + 0.5)
        }
      }
    }

    // 2) 墙段（户型图）
    if (plan.walls && plan.walls.length) {
      for (const w of plan.walls) {
        const list = w.parts || [w]
        for (const part of list) {
          const t = Math.max(part.t || w.t || 0.12, 0.05) * v.k
          ctx.strokeStyle = 'rgba(226,235,248,0.9)'
          ctx.lineWidth = t
          ctx.beginPath()
          const [ax, ay] = this.worldToScreen(part.ax, part.az, rot)
          const [bx, by] = this.worldToScreen(part.bx, part.bz, rot)
          ctx.moveTo(ax, ay)
          ctx.lineTo(bx, by)
          ctx.stroke()
        }
      }
      // 门洞用底色缺口表示
      ctx.strokeStyle = 'rgba(10,15,21,0.95)'
      for (const w of plan.walls) {
        for (const o of w.openings || []) {
          if (o.type !== 'door') continue
          const len = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1
          const ux = (w.bx - w.ax) / len
          const uz = (w.bz - w.az) / len
          const cx = w.ax + ux * o.c
          const cz = w.az + uz * o.c
          const half = o.w / 2
          ctx.lineWidth = Math.max(1.5, (w.t || 0.12) * v.k + 1.5)
          ctx.beginPath()
          const [x1, y1] = this.worldToScreen(cx - ux * half, cz - uz * half, rot)
          const [x2, y2] = this.worldToScreen(cx + ux * half, cz + uz * half, rot)
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          ctx.stroke()
        }
      }
    }

    ctx.restore()
  }

  /** 让整张图刚好装进视口 */
  fit() {
    this._view = null
  }
}

function niceScale(meters) {
  const steps = [0.5, 1, 2, 5, 10, 20, 50]
  for (const s of steps) {
    if (meters <= s) return s
  }
  return Math.round(meters / 10) * 10
}

/** 由户型墙段生成小地图数据 */
export function planFromWalls(walls, bounds) {
  return {
    walls,
    bounds: bounds || boundsOfWalls(walls),
  }
}

export function boundsOfWalls(walls) {
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const w of walls) {
    const half = (w.t || 0.12) / 2
    for (const [x, z] of [
      [w.ax, w.az],
      [w.bx, w.bz],
    ]) {
      minX = Math.min(minX, x - half)
      maxX = Math.max(maxX, x + half)
      minZ = Math.min(minZ, z - half)
      maxZ = Math.max(maxZ, z + half)
    }
  }
  if (!isFinite(minX)) return { minX: -5, minZ: -5, maxX: 5, maxZ: 5 }
  return { minX, minZ, maxX, maxZ }
}

/** 由烘出来的墙体栅格生成小地图数据 */
export function planFromGrid(grid, bounds) {
  return { wallGrid: grid, bounds }
}
