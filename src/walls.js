// 由墙段生成 3D 房子。户型图编辑器和内置样板间共用这一套。
// 墙段数据格式:
//   { ax, az, bx, bz, t?, openings?: [{ type:'door'|'window', c, w, sill?, head? }] }
//   c = 洞口中心距 A 点的距离(米)，w = 洞口宽度(米)
import * as THREE from 'three'
import { Grid, interiorMask, maskToShapes, shapeToFloorGeometry, simplify } from './raster.js'
import { wallTexture, tileTexture, woodFloorTexture, marbleTexture } from './textures.js'

export const DEFAULT_DOOR_H = 2.1
export const DEFAULT_SILL = 0.9
export const DEFAULT_HEAD = 2.3

const _matCache = new Map()

function mat(key, factory) {
  if (!_matCache.has(key)) _matCache.set(key, factory())
  return _matCache.get(key)
}

export function wallMaterial(color = '#f2efe9') {
  return mat('wall' + color, () =>
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      map: wallTexture(),
      roughness: 0.94,
      metalness: 0,
    })
  )
}

export function floorMaterial(kind = 'wood') {
  return mat('floor' + kind, () => {
    if (kind === 'tile') {
      return new THREE.MeshStandardMaterial({ map: tileTexture(), roughness: 0.28, metalness: 0.02 })
    }
    if (kind === 'marble') {
      return new THREE.MeshStandardMaterial({ map: marbleTexture(), roughness: 0.14, metalness: 0.04 })
    }
    return new THREE.MeshStandardMaterial({ map: woodFloorTexture(), roughness: 0.62, metalness: 0.0 })
  })
}

export function ceilingMaterial() {
  return mat('ceiling', () =>
    new THREE.MeshStandardMaterial({ color: 0xfbfaf7, roughness: 1, metalness: 0, side: THREE.DoubleSide })
  )
}

export function glassMaterial() {
  return mat('glass', () =>
    new THREE.MeshStandardMaterial({
      color: 0xcfe6f5,
      transparent: true,
      opacity: 0.16,
      roughness: 0.05,
      metalness: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  )
}

export function frameMaterial(color = '#e9e6e0') {
  return mat('frame' + color, () =>
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.5, metalness: 0.05 })
  )
}

export function plinthMaterial() {
  return mat('plinth', () =>
    new THREE.MeshStandardMaterial({ color: 0xf7f6f3, roughness: 0.7, metalness: 0 })
  )
}

/* ───────────────── 墙 ───────────────── */

function segBox(len, h, t, matr) {
  const g = new THREE.BoxGeometry(Math.max(len, 0.001), Math.max(h, 0.001), t)
  const m = new THREE.Mesh(g, matr)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

function placeSeg(mesh, ax, az, bx, bz, from, to, y0, y1) {
  // from/to 是沿墙的起止距离；y0/y1 是高度范围
  const len = Math.hypot(bx - ax, bz - az) || 1
  const ux = (bx - ax) / len
  const uz = (bz - az) / len
  const mid = (from + to) / 2
  mesh.position.set(ax + ux * mid, (y0 + y1) / 2, az + uz * mid)
  mesh.rotation.y = -Math.atan2(uz, ux)
  return mesh
}

/**
 * 生成整组墙体。返回 { group, solids }，solids 是可参与碰撞的网格数组。
 */
export function buildWalls(walls, opts = {}) {
  const {
    height = 2.8,
    defaultThickness = 0.12,
    wallMat = wallMaterial(),
    extendEnds = true,
  } = opts

  const group = new THREE.Group()
  group.name = 'walls'

  for (const w of walls) {
    const ax = w.ax
    const az = w.az
    const bx = w.bx
    const bz = w.bz
    const t = w.t || defaultThickness
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 1e-4) continue

    // 端点各延长半个墙厚，转角处才不会留缝
    const ext = extendEnds ? t / 2 : 0
    const ux = (bx - ax) / len
    const uz = (bz - az) / len
    const sax = ax - ux * ext
    const saz = az - uz * ext
    const sbx = bx + ux * ext
    const sbz = bz + uz * ext

    // 把洞口按位置排序并裁剪到墙长内
    const ops = (w.openings || [])
      .map((o) => ({
        type: o.type || 'door',
        c: Math.min(Math.max(o.c, 0), len),
        w: Math.min(o.w || 0.9, len),
        sill: o.sill ?? DEFAULT_SILL,
        head: o.head ?? DEFAULT_HEAD,
      }))
      .sort((a, b2) => a.c - b2.c)

    // 计算实心段
    const runs = []
    let cursor = 0
    for (const o of ops) {
      const s = Math.max(0, o.c - o.w / 2)
      const e = Math.min(len, o.c + o.w / 2)
      if (s > cursor) runs.push([cursor, s])
      cursor = Math.max(cursor, e)
    }
    if (cursor < len) runs.push([cursor, len])

    for (const [s, e] of runs) {
      if (e - s < 1e-4) continue
      const m = segBox(e - s, height, t, wallMat)
      placeSeg(m, sax, saz, sbx, sbz, s + ext, e + ext, 0, height)
      group.add(m)
    }

    for (const o of ops) {
      const s = o.c - o.w / 2 + ext
      const e = o.c + o.w / 2 + ext

      if (o.type === 'door') {
        const doorH = o.head ?? DEFAULT_DOOR_H
        if (height - doorH > 1e-3) {
          const m = segBox(o.w, height - doorH, t, wallMat)
          placeSeg(m, sax, saz, sbx, sbz, s, e, doorH, height)
          group.add(m)
        }
        // 门套
        const jamb = frameMaterial()
        const jw = 0.05
        for (const at of [s + jw / 2, e - jw / 2]) {
          const j = segBox(jw, doorH, t + 0.02, jamb)
          placeSeg(j, sax, saz, sbx, sbz, at, at, 0, doorH)
          group.add(j)
        }
        const head = segBox(e - s, 0.06, t + 0.02, jamb)
        placeSeg(head, sax, saz, sbx, sbz, s, e, doorH - 0.06, doorH)
        group.add(head)
      } else {
        // 窗：下墙裙 + 上过梁 + 玻璃 + 窗框
        const sill = o.sill
        const headY = Math.min(o.head, height)
        if (sill > 1e-3) {
          const m = segBox(o.w, sill, t, wallMat)
          placeSeg(m, sax, saz, sbx, sbz, s, e, 0, sill)
          group.add(m)
        }
        if (height - headY > 1e-3) {
          const m = segBox(o.w, height - headY, t, wallMat)
          placeSeg(m, sax, saz, sbx, sbz, s, e, headY, height)
          group.add(m)
        }
        const glass = segBox(e - s - 0.06, headY - sill - 0.06, 0.012, glassMaterial())
        placeSeg(glass, sax, saz, sbx, sbz, s + 0.03, e - 0.03, sill + 0.03, headY - 0.03)
        glass.castShadow = false
        glass.receiveShadow = false
        glass.userData.noCollide = true
        group.add(glass)

        const fm = frameMaterial()
        const fw = 0.06
        for (const at of [s + fw / 2, e - fw / 2]) {
          const f = segBox(fw, headY - sill, t * 0.7, fm)
          placeSeg(f, sax, saz, sbx, sbz, at, at, sill, headY)
          group.add(f)
        }
        for (const [y0, y1] of [
          [sill, sill + fw],
          [headY - fw, headY],
        ]) {
          const f = segBox(e - s, fw, t * 0.7, fm)
          placeSeg(f, sax, saz, sbx, sbz, s, e, y0, y1)
          group.add(f)
        }
        // 竖中挺
        const mid = segBox(0.04, headY - sill, t * 0.6, fm)
        placeSeg(mid, sax, saz, sbx, sbz, o.c + ext, o.c + ext, sill, headY)
        group.add(mid)
      }
    }
  }

  return { group }
}

/* ───────────────── 地板 / 天花板 ───────────────── */

/** 把墙撒到栅格上，返回栅格和它的世界边界（含墙厚外扩） */
export function rasterizeWalls(walls, { cell = 0.08, pad = 0.6, defaultThickness = 0.12 } = {}) {
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const w of walls) {
    const h = (w.t || defaultThickness) / 2
    for (const [x, z] of [
      [w.ax, w.az],
      [w.bx, w.bz],
    ]) {
      minX = Math.min(minX, x - h)
      maxX = Math.max(maxX, x + h)
      minZ = Math.min(minZ, z - h)
      maxZ = Math.max(maxZ, z + h)
    }
  }
  if (!isFinite(minX)) return null
  minX -= pad
  minZ -= pad
  maxX += pad
  maxZ += pad

  const grid = new Grid(minX, minZ, maxX, maxZ, cell)
  for (const w of walls) {
    const t = w.t || defaultThickness
    // 实心部分照原样撒；洞口处依然要有墙，否则室内外会连通
    grid.stampSegment(w.ax, w.az, w.bx, w.bz, t, 1)
  }
  return { grid, bounds: { minX, minZ, maxX, maxZ } }
}

/**
 * 生成地板和天花板
 * @returns {{ floor: THREE.Mesh|null, ceiling: THREE.Mesh|null, interiorTiles: number, bounds: object }}
 */
export function buildSlab(walls, opts = {}) {
  const {
    cell = 0.08,
    height = 2.8,
    floorKind = 'wood',
    thickness = 0.08,
    bounds: boundsIn = null,
    shapes: shapesIn = null,
  } = opts

  const raster = shapesIn ? null : rasterizeWalls(walls, { cell })
  const bounds = boundsIn || (raster ? raster.bounds : null)
  const grid = raster ? raster.grid : null

  let shapes = shapesIn
  let interiorTiles = 0

  if (!shapes) {
    if (!grid) return { floor: null, ceiling: null, interiorTiles: 0, bounds: null }
    const { mask, count } = interiorMask(grid, 1)
    interiorTiles = count
    if (!count) {
      // 墙体没围起来（比如只有几段墙），退化成一个覆盖全部墙的方块地板
      return { floor: null, ceiling: null, interiorTiles: 0, bounds, grid }
    }
    shapes = maskToShapes(grid, mask, { simplifyEps: 1.6, minArea: 2.0 })
  }

  const group = new THREE.Group()
  group.name = 'slab'

  const fMat = floorMaterial(floorKind)
  for (const shape of shapes) {
    const g = shapeToFloorGeometry(shape, 0, 2.0)
    const m = new THREE.Mesh(g, fMat)
    m.receiveShadow = true
    m.castShadow = false
    group.add(m)
  }

  // 地板下加一层薄板，从外面看房子不是纸片
  const baseMat = mat('slabBase', () =>
    new THREE.MeshStandardMaterial({ color: 0xdfdcd5, roughness: 0.95, metalness: 0 })
  )
  for (const shape of shapes) {
    const g = shapeToFloorGeometry(shape, -thickness, 2.0)
    const m = new THREE.Mesh(g, baseMat)
    m.receiveShadow = true
    group.add(m)
  }

  // 天花板
  const cMat = ceilingMaterial()
  for (const shape of shapes) {
    const g = shapeToFloorGeometry(shape, 0, 2.0)
    g.rotateX(Math.PI) // 翻过来朝下
    g.translate(0, height, 0)
    const m = new THREE.Mesh(g, cMat)
    m.receiveShadow = true
    m.userData.isCeiling = true
    group.add(m)
  }

  // 踢脚线
  const pMat = plinthMaterial()
  for (const w of walls) {
    const t = w.t || 0.12
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az)
    if (len < 0.2) continue
    const ops = (w.openings || []).filter((o) => (o.type || 'door') === 'door')
    // 有门洞的墙，踢脚线分段绕开
    const cuts = ops
      .map((o) => [Math.max(0, o.c - o.w / 2), Math.min(len, o.c + o.w / 2)])
      .sort((a, b) => a[0] - b[0])
    let cursor = 0
    const runs = []
    for (const [s, e] of cuts) {
      if (s > cursor) runs.push([cursor, s])
      cursor = Math.max(cursor, e)
    }
    if (cursor < len) runs.push([cursor, len])
    for (const [s, e] of runs) {
      if (e - s < 0.12) continue
      const g = new THREE.BoxGeometry(e - s, 0.1, 0.018)
      const m = new THREE.Mesh(g, pMat)
      const ux = (w.bx - w.ax) / len
      const uz = (w.bz - w.az) / len
      const mid = (s + e) / 2
      const nx = -uz
      const nz = ux
      // 踢脚线贴在墙一侧，稍微往里偏一点
      m.position.set(w.ax + ux * mid - nx * (t / 2 + 0.011), 0.05, w.az + uz * mid - nz * (t / 2 + 0.011))
      m.rotation.y = -Math.atan2(uz, ux)
      m.castShadow = false
      m.receiveShadow = true
      group.add(m)
    }
  }

  return { group, interiorTiles, bounds, grid, shapes }
}

/**
 * 由一组墙直接造出可看的房子
 */
export function buildHouse(walls, opts = {}) {
  const height = opts.height ?? 2.8
  const root = new THREE.Group()
  root.name = 'house'

  const slab = buildSlab(walls, { height, floorKind: opts.floorKind || 'wood', cell: opts.cell || 0.08 })
  if (slab.group) root.add(slab.group)

  const { group: wallGroup } = buildWalls(walls, {
    height,
    defaultThickness: opts.thickness ?? 0.12,
  })
  root.add(wallGroup)

  return { root, slab, walls }
}

export function disposeMaterialCache() {
  for (const m of _matCache.values()) m.dispose?.()
  _matCache.clear()
}
