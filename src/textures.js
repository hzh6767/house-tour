// 用 canvas 现场生成材质贴图 —— 不依赖任何图片资源，离线也能用。
// 生成结果会缓存，重复调用不重复绘制。
import * as THREE from 'three'

const cache = new Map()

const HAS_CANVAS = typeof document !== 'undefined'

function makeCanvas(size) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  return c
}

function finish(canvas, repeat = 1, { srgb = true, aniso = 8 } = {}) {
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(repeat, repeat)
  tex.anisotropy = aniso
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

function cached(key, fn) {
  if (!HAS_CANVAS) return null
  if (!cache.has(key)) cache.set(key, fn())
  return cache.get(key)
}

// 轻量值噪声，用于给贴图加脏感
function noiseFill(ctx, size, amount, seed = 1) {
  const img = ctx.getImageData(0, 0, size, size)
  const d = img.data
  let s = seed * 9301 + 49297
  for (let i = 0; i < d.length; i += 4) {
    s = (s * 9301 + 49297) % 233280
    const n = (s / 233280 - 0.5) * amount
    d[i] = clamp255(d[i] + n)
    d[i + 1] = clamp255(d[i + 1] + n)
    d[i + 2] = clamp255(d[i + 2] + n)
  }
  ctx.putImageData(img, 0, 0)
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function rgba(r, g, b, a = 1) {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`
}

function hsl(h, s, l, a = 1) {
  return `hsla(${h},${s}%,${l}%,${a})`
}

/* ────────────── 木地板 ────────────── */
export function woodFloorTexture(seed = 1) {
  return cached('wood' + seed, () => {
    const S = 1024
    const c = makeCanvas(S)
    const ctx = c.getContext('2d')
    const PLANKS = 8
    const ph = S / PLANKS
    ctx.fillStyle = '#8a6440'
    ctx.fillRect(0, 0, S, S)

    let s = seed * 7919
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280
      return s / 233280
    }

    for (let row = 0; row < PLANKS; row++) {
      const y = row * ph
      // 每块板的色相/明度略有差异
      const l = 30 + rnd() * 14
      const h = 26 + rnd() * 10
      ctx.fillStyle = hsl(h, 34, l)
      ctx.fillRect(0, y, S, ph)

      // 木纹
      for (let g = 0; g < 26; g++) {
        const gy = y + 4 + rnd() * (ph - 8)
        ctx.strokeStyle = hsl(h, 30, l - 6 - rnd() * 8, 0.16 + rnd() * 0.2)
        ctx.lineWidth = 0.6 + rnd() * 1.6
        ctx.beginPath()
        ctx.moveTo(0, gy)
        const amp = 1.5 + rnd() * 3.5
        for (let x = 0; x <= S; x += 32) {
          ctx.lineTo(x, gy + Math.sin((x / S) * Math.PI * 3 + row) * amp)
        }
        ctx.stroke()
      }

      // 板缝
      ctx.strokeStyle = 'rgba(40,24,12,0.55)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, y + ph - 1)
      ctx.lineTo(S, y + ph - 1)
      ctx.stroke()

      // 每行错开一块板的短接缝
      const off = ((row * 0.37 + rnd() * 0.3) % 1) * S
      ctx.beginPath()
      ctx.moveTo(off, y)
      ctx.lineTo(off, y + ph)
      ctx.strokeStyle = 'rgba(40,24,12,0.45)'
      ctx.stroke()
    }

    noiseFill(ctx, S, 12, seed)
    return finish(c, 1)
  })
}

/* ────────────── 瓷砖 ────────────── */
export function tileTexture(seed = 1) {
  return cached('tile' + seed, () => {
    const S = 1024
    const c = makeCanvas(S)
    const ctx = c.getContext('2d')
    const N = 4
    const t = S / N
    ctx.fillStyle = '#c9c7c2'
    ctx.fillRect(0, 0, S, S)

    let s = seed * 104729
    const rnd = () => {
      s = (s * 9301 + 49297) % 233280
      return s / 233280
    }

    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const l = 72 + rnd() * 8
        const h = 200 + rnd() * 20
        ctx.fillStyle = hsl(h, 6, l)
        ctx.fillRect(i * t + 3, j * t + 3, t - 6, t - 6)

        // 大理石般的纹理
        ctx.save()
        ctx.beginPath()
        ctx.rect(i * t + 3, j * t + 3, t - 6, t - 6)
        ctx.clip()
        for (let k = 0; k < 5; k++) {
          ctx.strokeStyle = hsl(h, 10, l - 14 - rnd() * 10, 0.25)
          ctx.lineWidth = 0.8 + rnd() * 2
          ctx.beginPath()
          let x = i * t + rnd() * t
          let y = j * t
          ctx.moveTo(x, y)
          for (let step = 0; step < 6; step++) {
            x += (rnd() - 0.5) * 40
            y += t / 6
            ctx.lineTo(x, y)
          }
          ctx.stroke()
        }
        ctx.restore()
      }
    }
    noiseFill(ctx, S, 8, seed + 3)
    return finish(c, 1)
  })
}

/* ────────────── 墙面乳胶漆 ────────────── */
export function wallTexture(hue = 42, sat = 16, light = 88) {
  return cached(`wall${hue}-${sat}-${light}`, () => {
    const S = 512
    const c = makeCanvas(S)
    const ctx = c.getContext('2d')
    ctx.fillStyle = hsl(hue, sat, light)
    ctx.fillRect(0, 0, S, S)

    // 轻微的滚涂痕迹
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * S
      const y = Math.random() * S
      ctx.fillStyle = hsl(hue, sat, light + (Math.random() - 0.5) * 5, 0.5)
      ctx.beginPath()
      ctx.ellipse(x, y, 20 + Math.random() * 60, 8 + Math.random() * 22, Math.random() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
    noiseFill(ctx, S, 9, 11)
    return finish(c, 1)
  })
}

/* ────────────── 地毯 / 织物 ────────────── */
export function carpetTexture(r = 118, g = 112, b = 104) {
  return cached(`carpet${r}-${g}-${b}`, () => {
    const S = 512
    const c = makeCanvas(S)
    const ctx = c.getContext('2d')
    ctx.fillStyle = rgba(r, g, b)
    ctx.fillRect(0, 0, S, S)
    for (let i = 0; i < 26000; i++) {
      const x = Math.random() * S
      const y = Math.random() * S
      const d = (Math.random() - 0.5) * 42
      ctx.fillStyle = rgba(r + d, g + d, b + d, 0.5)
      ctx.fillRect(x, y, 2.2, 2.2)
    }
    return finish(c, 1)
  })
}

/* ────────────── 布料（沙发/床品） ────────────── */
export function fabricTexture(r, g, b) {
  return cached(`fabric${r}-${g}-${b}`, () => {
    const S = 512
    const c = makeCanvas(S)
    const ctx = c.getContext('2d')
    ctx.fillStyle = rgba(r, g, b)
    ctx.fillRect(0, 0, S, S)
    ctx.strokeStyle = 'rgba(255,255,255,0.045)'
    ctx.lineWidth = 1
    for (let i = 0; i < S; i += 4) {
      ctx.beginPath()
      ctx.moveTo(i, 0)
      ctx.lineTo(i, S)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, i)
      ctx.lineTo(S, i)
      ctx.stroke()
    }
    noiseFill(ctx, S, 16, 5)
    return finish(c, 1)
  })
}

/* ────────────── 大理石台面 ────────────── */
export function marbleTexture() {
  return cached('marble', () => {
    const S = 1024
    const c = makeCanvas(S)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#eceae5'
    ctx.fillRect(0, 0, S, S)
    for (let k = 0; k < 26; k++) {
      ctx.strokeStyle = `rgba(120,124,132,${0.05 + Math.random() * 0.16})`
      ctx.lineWidth = 0.8 + Math.random() * 5
      ctx.beginPath()
      let x = Math.random() * S
      let y = -50
      ctx.moveTo(x, y)
      while (y < S + 50) {
        x += (Math.random() - 0.5) * 90
        y += 26 + Math.random() * 40
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    noiseFill(ctx, S, 7, 23)
    return finish(c, 1)
  })
}

/* ────────────── 金属 / 拉丝 ────────────── */
export function brushedMetalTexture() {
  return cached('metal', () => {
    const S = 512
    const c = makeCanvas(S)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#b9bcc0'
    ctx.fillRect(0, 0, S, S)
    for (let i = 0; i < 4200; i++) {
      const y = Math.random() * S
      ctx.strokeStyle = `rgba(255,255,255,${Math.random() * 0.08})`
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(S, y)
      ctx.stroke()
    }
    return finish(c, 1)
  })
}

/* ────────────── 窗外的天空 / 远景 ────────────── */
export function skyGradientTexture() {
  return cached('sky', () => {
    const W = 512
    const H = 512
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#5d8ed4')
    g.addColorStop(0.45, '#9dc0e8')
    g.addColorStop(0.72, '#d7e5f2')
    g.addColorStop(1, '#eeeae2')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)

    // 一点云
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * W
      const y = Math.random() * H * 0.6
      const rx = 30 + Math.random() * 90
      const ry = rx * (0.25 + Math.random() * 0.2)
      ctx.fillStyle = `rgba(255,255,255,${0.06 + Math.random() * 0.16})`
      ctx.beginPath()
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    return tex
  })
}

/* ────────────── 户型图编辑器用的底图 ────────────── */
// 给示例户型生成一张看起来像 CAD 平面图的底图
export function floorPlanSheet(walls, opts = {}) {
  const S = opts.size || 1400
  const pad = opts.pad ?? 60
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')

  ctx.fillStyle = '#f7f5f0'
  ctx.fillRect(0, 0, S, S)

  // 网格
  const step = S / 28
  ctx.strokeStyle = 'rgba(120,130,145,0.13)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 28; i++) {
    ctx.beginPath()
    ctx.moveTo(i * step, 0)
    ctx.lineTo(i * step, S)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i * step)
    ctx.lineTo(S, i * step)
    ctx.stroke()
  }

  if (walls && walls.length) {
    const xs = walls.flatMap((w) => [w.ax, w.bx])
    const ys = walls.flatMap((w) => [w.ay, w.by])
    const minx = Math.min(...xs)
    const maxx = Math.max(...xs)
    const miny = Math.min(...ys)
    const maxy = Math.max(...ys)
    const span = Math.max(maxx - minx, maxy - miny) || 1
    const k = (S - pad * 2) / span
    const ox = pad + (S - pad * 2 - (maxx - minx) * k) / 2 - minx * k
    const oy = pad + (S - pad * 2 - (maxy - miny) * k) / 2 - miny * k

    ctx.lineCap = 'round'
    for (const w of walls) {
      ctx.strokeStyle = '#2f3641'
      ctx.lineWidth = Math.max(3, (w.t || 0.12) * k)
      ctx.beginPath()
      ctx.moveTo(w.ax * k + ox, w.ay * k + oy)
      ctx.lineTo(w.bx * k + ox, w.by * k + oy)
      ctx.stroke()
    }
    // 门洞画成白色缺口 + 弧线
    for (const w of walls) {
      for (const o of w.openings || []) {
        if (o.type !== 'door') continue
        const len = Math.hypot(w.bx - w.ax, w.by - w.ay)
        if (!len) continue
        const ux = (w.bx - w.ax) / len
        const uy = (w.by - w.ay) / len
        const cx = w.ax + ux * o.c
        const cy = w.ay + uy * o.c
        const half = o.w / 2
        ctx.strokeStyle = '#f7f5f0'
        ctx.lineWidth = Math.max(5, (w.t || 0.12) * k + 3)
        ctx.beginPath()
        ctx.moveTo((cx - ux * half) * k + ox, (cy - uy * half) * k + oy)
        ctx.lineTo((cx + ux * half) * k + ox, (cy + uy * half) * k + oy)
        ctx.stroke()
        ctx.strokeStyle = 'rgba(90,100,115,0.5)'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.arc((cx - ux * half) * k + ox, (cy - uy * half) * k + oy, half * k, Math.atan2(uy, ux), Math.atan2(uy, ux) + Math.PI / 2)
        ctx.stroke()
      }
    }
  }

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return { canvas: c, texture: tex }
}

export function disposeTextureCache() {
  for (const t of cache.values()) {
    if (t && t.dispose) t.dispose()
  }
  cache.clear()
}
