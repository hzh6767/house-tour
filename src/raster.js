// 网格化工具。
// 两个用途：
//   1) 户型图建的房子 —— 把墙撒到栅格上，洪水填充求出「室内」，再提取轮廓当作地板/天花板的形状
//   2) 导入的模型 —— 把竖直面片投影到俯视图，得到小地图要画的墙体底图
import * as THREE from 'three'

// 格子总数上限（约 4000×4000）。再多内存和洪水填充时间都扛不住，
// 超出时自动把格子放大，而不是任由分配失败把页面搞崩。
export const MAX_GRID_CELLS = 16_000_000

export class Grid {
  constructor(minX, minZ, maxX, maxZ, cell) {
    if (![minX, minZ, maxX, maxZ, cell].every(Number.isFinite) || cell <= 0) {
      throw new Error('Grid: 范围或格子尺寸不是有效数字')
    }
    const spanX = Math.max(maxX - minX, cell)
    const spanZ = Math.max(maxZ - minZ, cell)
    const need = (spanX / cell) * (spanZ / cell)
    if (need > MAX_GRID_CELLS) {
      cell *= Math.sqrt(need / MAX_GRID_CELLS) * 1.01
      console.warn(`[raster] 范围过大，格子自动放大到 ${cell.toFixed(3)} m`)
    }
    this.cell = cell
    this.minX = minX
    this.minZ = minZ
    this.w = Math.max(2, Math.ceil(spanX / cell))
    this.h = Math.max(2, Math.ceil(spanZ / cell))
    this.data = new Uint8Array(this.w * this.h)
  }

  idx(gx, gy) {
    return gy * this.w + gx
  }

  get(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) return 0
    return this.data[gy * this.w + gx]
  }

  set(gx, gy, v = 1) {
    if (gx < 0 || gy < 0 || gx >= this.w || gy >= this.h) return
    this.data[gy * this.w + gx] = v
  }

  toGrid(x, z) {
    return { gx: (x - this.minX) / this.cell, gy: (z - this.minZ) / this.cell }
  }

  toWorld(gx, gy) {
    return { x: this.minX + gx * this.cell, z: this.minZ + gy * this.cell }
  }

  /** 每个格子中心的平均世界坐标（采样用） */
  cellCenter(gx, gy) {
    return { x: this.minX + (gx + 0.5) * this.cell, z: this.minZ + (gy + 0.5) * this.cell }
  }

  /** 把一个世界坐标的圆盘涂上值 */
  stamp(px, pz, radius, value = 1) {
    const c = this.cell
    const g0 = this.toGrid(px - radius, pz - radius)
    const g1 = this.toGrid(px + radius, pz + radius)
    const x0 = Math.max(0, Math.floor(g0.gx))
    const x1 = Math.min(this.w - 1, Math.ceil(g1.gx))
    const y0 = Math.max(0, Math.floor(g0.gy))
    const y1 = Math.min(this.h - 1, Math.ceil(g1.gy))
    const r2 = radius * radius
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const { x, z } = this.cellCenter(gx, gy)
        const dx = x - px
        const dz = z - pz
        if (dx * dx + dz * dz <= r2) this.data[gy * this.w + gx] = value
      }
    }
  }

  /** 画一条有厚度的线段 */
  stampSegment(ax, az, bx, bz, thickness, value = 1) {
    const r = thickness / 2 + this.cell * 0.5
    const len = Math.hypot(bx - ax, bz - az)
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.5)))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      this.stamp(ax + (bx - ax) * t, az + (bz - az) * t, r, value)
    }
  }

  /** 画一个实心矩形（画布坐标用世界坐标给） */
  stampRect(minX, minZ, maxX, maxZ, value = 1) {
    const g0 = this.toGrid(minX, minZ)
    const g1 = this.toGrid(maxX, maxZ)
    const x0 = Math.max(0, Math.floor(g0.gx))
    const x1 = Math.min(this.w - 1, Math.ceil(g1.gx))
    const y0 = Math.max(0, Math.floor(g0.gy))
    const y1 = Math.min(this.h - 1, Math.ceil(g1.gy))
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) this.data[gy * this.w + gx] = value
    }
  }
}

/**
 * 洪水填充：从四周往里灌，标出「外部」
 * @returns {Uint8Array} 1 = 外部
 */
export function floodExterior(grid, blockedValue = 1) {
  const { w, h, data } = grid
  const out = new Uint8Array(w * h)
  const stack = []

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = y * w + x
    if (out[i] || data[i] === blockedValue) return
    out[i] = 1
    stack.push(i)
  }

  for (let x = 0; x < w; x++) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    push(0, y)
    push(w - 1, y)
  }

  while (stack.length) {
    const i = stack.pop()
    const x = i % w
    const y = (i / w) | 0
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }
  return out
}

/**
 * 内部掩码：不是墙、也不是外部，就是室内
 */
export function interiorMask(grid, blockedValue = 1) {
  const ext = floodExterior(grid, blockedValue)
  const m = new Uint8Array(grid.w * grid.h)
  let count = 0
  for (let i = 0; i < m.length; i++) {
    if (grid.data[i] !== blockedValue && !ext[i]) {
      m[i] = 1
      count++
    }
  }
  return { mask: m, count }
}

/**
 * Marching squares：把二值掩码的边界提取成若干闭合折线（栅格坐标）
 */
export function marchingSquares(mask, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x])
  const segs = []

  // 每个格点周围的 4 个格子构成一个 2x2 采样窗
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const a = at(x, y) // 左上
      const b = at(x + 1, y) // 右上
      const c = at(x + 1, y + 1) // 右下
      const d = at(x, y + 1) // 左下
      const code = a | (b << 1) | (c << 2) | (d << 3)
      if (code === 0 || code === 15) continue

      // 边中点坐标（相对格点 x,y）
      const T = [x + 0.5, y] // 上
      const R = [x + 1, y + 0.5] // 右
      const B = [x + 0.5, y + 1] // 下
      const L = [x, y + 0.5] // 左

      const add = (p, q) => segs.push([p[0], p[1], q[0], q[1]])

      switch (code) {
        case 1: add(L, T); break
        case 2: add(T, R); break
        case 3: add(L, R); break
        case 4: add(R, B); break
        case 5: add(L, T); add(R, B); break
        case 6: add(T, B); break
        case 7: add(L, B); break
        case 8: add(B, L); break
        case 9: add(B, T); break
        case 10: add(T, R); add(B, L); break
        case 11: add(B, R); break
        case 12: add(R, L); break
        case 13: add(R, T); break
        case 14: add(T, L); break
        default: break
      }
    }
  }

  // 把散线段串成闭合环
  const key = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`
  const buckets = new Map()
  segs.forEach((s, i) => {
    for (const [px, py] of [[s[0], s[1]], [s[2], s[3]]]) {
      const k = key(px, py)
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k).push(i)
    }
  })

  const used = new Uint8Array(segs.length)
  const loops = []

  const other = (i, x, y) => {
    const s = segs[i]
    const k0 = key(s[0], s[1])
    const k1 = key(s[2], s[3])
    return k0 === key(x, y) ? [s[2], s[3]] : [s[0], s[1]]
  }

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const loop = [[segs[i][0], segs[i][1]], [segs[i][2], segs[i][3]]]
    let guard = 0
    while (guard++ < 200000) {
      const last = loop[loop.length - 1]
      const cand = buckets.get(key(last[0], last[1])) || []
      let next = -1
      for (const j of cand) {
        if (!used[j]) {
          next = j
          break
        }
      }
      if (next < 0) break
      used[next] = 1
      const p = other(next, last[0], last[1])
      loop.push(p)
      if (Math.abs(p[0] - loop[0][0]) < 1e-6 && Math.abs(p[1] - loop[0][1]) < 1e-6) break
    }
    if (loop.length > 3) loops.push(loop)
  }

  return loops
}

/** Douglas–Peucker 简化 */
/** Douglas–Peucker，把 [s0,e0] 区间内该保留的点标记到 keep 上 */
function dpMark(points, s0, e0, eps, keep) {
  const stack = [[s0, e0]]
  while (stack.length) {
    const [s, e] = stack.pop()
    if (e - s < 2) continue
    let maxD = 0
    let maxI = -1
    const [x1, y1] = points[s]
    const [x2, y2] = points[e]
    const dx = x2 - x1
    const dy = y2 - y1
    const den = Math.hypot(dx, dy) || 1
    for (let i = s + 1; i < e; i++) {
      const [px, py] = points[i]
      const d = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / den
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > eps && maxI > 0) {
      keep[maxI] = 1
      stack.push([s, maxI], [maxI, e])
    }
  }
}

export function simplify(points, eps) {
  if (points.length < 4) return points

  // marchingSquares 返回的是闭合环（首尾同一点）。如果直接拿 [0, last] 当 DP 的基准线段，
  // 这条线段长度为零，环上每一点到它的距离都是 0，整圈会被压成两个重合点。
  // 所以闭合环要先在离起点最远处断开，分成两段分别简化，最后再恢复闭合。
  const first = points[0]
  const last = points[points.length - 1]
  const closed =
    Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6

  const pts = closed ? points.slice(0, points.length - 1) : points
  if (pts.length < 4) return points

  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1

  if (closed) {
    let far = 1
    let farD = -1
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1])
      if (d > farD) {
        farD = d
        far = i
      }
    }
    keep[far] = 1
    dpMark(pts, 0, far, eps, keep)
    dpMark(pts, far, pts.length - 1, eps, keep)
  } else {
    dpMark(pts, 0, pts.length - 1, eps, keep)
  }

  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  if (closed) out.push(out[0])
  return out
}

export function polygonArea(pts) {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
  }
  return a / 2
}

/**
 * 由掩码生成可用于 ShapeGeometry 的形状（世界坐标 XY，随后绕 X 转 -90° 铺到 XZ）
 */
export function maskToShapes(grid, mask, { simplifyEps = 1.2, minArea = 0 } = {}) {
  const loops = marchingSquares(mask, grid.w, grid.h)
  const polys = []
  for (const loop of loops) {
    const simp = simplify(loop, simplifyEps)
    if (simp.length < 4) continue
    const area = Math.abs(polygonArea(simp)) * grid.cell * grid.cell
    if (area < minArea) continue
    polys.push({ pts: simp, area, ccw: polygonArea(simp) > 0 })
  }
  polys.sort((a, b) => b.area - a.area)

  const shapes = []
  const used = new Set()

  for (let i = 0; i < polys.length; i++) {
    if (used.has(i)) continue
    const p = polys[i]
    if (!p.ccw) continue // 只拿外轮廓，孔洞单独处理
    used.add(i)
    const shape = new THREE.Shape(p.pts.map(([gx, gy]) => {
      const wx = grid.minX + gx * grid.cell
      const wz = grid.minZ + gy * grid.cell
      return new THREE.Vector2(wx, -wz)
    }))
    shapes.push({ shape, area: p.area })
  }

  // 没有闭合外轮廓时，退化成一个包围盒
  if (!shapes.length) {
    const shape = new THREE.Shape([
      new THREE.Vector2(grid.minX, -grid.minZ),
      new THREE.Vector2(grid.minX + grid.w * grid.cell, -grid.minZ),
      new THREE.Vector2(grid.minX + grid.w * grid.cell, -(grid.minZ + grid.h * grid.cell)),
      new THREE.Vector2(grid.minX, -(grid.minZ + grid.h * grid.cell)),
    ])
    shapes.push({ shape, area: grid.w * grid.h * grid.cell * grid.cell })
  }

  return shapes.map((s) => s.shape)
}

/** 把 XY 平面上的形状铺到 XZ 地面，并按米设置 UV 平铺 */
export function shapeToFloorGeometry(shape, y = 0, tileMeters = 2) {
  const geo = new THREE.ShapeGeometry(shape)
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, y, 0)
  const uv = geo.attributes.uv
  if (uv && tileMeters > 0) {
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) / tileMeters, uv.getY(i) / tileMeters)
    }
    uv.needsUpdate = true
  }
  geo.computeVertexNormals()
  return geo
}

/**
 * 从任意模型里烘出俯视墙体图（给小地图用）。
 * 思路：遍历三角形，法线接近水平的当作墙，把它的 XZ 投影画到栅格上。
 */
export function bakeFootprint(root, cell = 0.12) {
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return null
  const minX = box.min.x
  const minZ = box.min.z
  const maxX = box.max.x
  const maxZ = box.max.z
  const w = Math.ceil((maxX - minX) / cell)
  const h = Math.ceil((maxZ - minZ) / cell)
  if (w * h > 4_000_000) return null // 太大就放弃，避免卡顿

  const grid = new Grid(minX, minZ, maxX, maxZ, cell)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const n = new THREE.Vector3()
  const m4 = new THREE.Matrix4()

  let scanned = 0
  const MAX_TRIS = 900_000

  root.updateMatrixWorld(true)
  root.traverse((o) => {
    if (scanned > MAX_TRIS) return
    if (!o.isMesh || !o.geometry || !o.geometry.attributes?.position) return
    if (o.userData.noCollide) return
    const g = o.geometry
    const pos = g.attributes.position
    const index = g.index
    const triCount = Math.floor((index ? index.count : pos.count) / 3)
    const step = Math.max(1, Math.floor(triCount / Math.max(1, Math.ceil(MAX_TRIS / 4))))
    m4.copy(o.matrixWorld)

    for (let t = 0; t < triCount; t += step) {
      const i0 = index ? index.getX(t * 3) : t * 3
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
      a.fromBufferAttribute(pos, i0).applyMatrix4(m4)
      b.fromBufferAttribute(pos, i1).applyMatrix4(m4)
      c.fromBufferAttribute(pos, i2).applyMatrix4(m4)
      ab.subVectors(b, a)
      ac.subVectors(c, a)
      n.crossVectors(ab, ac)
      const nl = n.length()
      if (nl < 1e-9) continue
      n.divideScalar(nl)
      // 只保留竖直方向的面（墙）。地板朝上、天花板朝下都跳过
      if (Math.abs(n.y) > 0.72) continue
      scanned++
      // 投影到 XZ 后画线；按长度细分，避免长墙漏格
      const segLen = Math.hypot(b.x - a.x, b.z - a.z)
      const sub = Math.max(1, Math.ceil(segLen / (cell * 0.7)))
      for (let s = 0; s < sub; s++) {
        for (const [p, q] of [
          [a, b],
          [b, c],
          [c, a],
        ]) {
          const t0 = s / sub
          const t1 = (s + 1) / sub
          const x0 = p.x + (q.x - p.x) * t0
          const z0 = p.z + (q.z - p.z) * t0
          const x1 = p.x + (q.x - p.x) * t1
          const z1 = p.z + (q.z - p.z) * t1
          if (Math.hypot(x1 - x0, z1 - z0) < 1e-6) continue
          grid.stampSegment(x0, z0, x1, z1, cell * 0.9, 1)
        }
      }
      if (scanned > MAX_TRIS) break
    }
  })

  return { grid, bounds: { minX, minZ, maxX, maxZ } }
}
