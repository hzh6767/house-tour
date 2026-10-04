// 内置样板间：一套三室两厅。用于「先看看示例」。
// 数据全部用米，墙段格式和户型图编辑器产出的完全一致。
import * as THREE from 'three'
import { buildHouse, floorMaterial, wallMaterial, frameMaterial, glassMaterial } from './walls.js'
import { fabricTexture, woodFloorTexture, marbleTexture, brushedMetalTexture, carpetTexture } from './textures.js'

export const SAMPLE_NAME = '样板间 · 三室两厅'

// 户型：外轮廓 12.6m × 8.4m
//   x 0–4.0    主卧      z 0–3.6
//   x 4.0–8.0  次卧      z 0–3.6
//   x 8.0–10.2 卫生间    z 0–3.6
//   x 10.2–12.6 书房     z 0–3.6
//   x 0–8.6    客厅餐厅  z 3.6–8.4
//   x 8.6–12.6 厨房      z 3.6–8.4
const T = 0.14 // 外墙厚
const TI = 0.11 // 内墙厚

export const SAMPLE_WALLS = [
  // ── 外墙 ──
  {
    ax: 0, az: 0, bx: 12.6, bz: 0, t: T, label: '北外墙',
    openings: [
      { type: 'window', c: 2.0, w: 1.8, sill: 0.85, head: 2.35 },
      { type: 'window', c: 6.0, w: 1.6, sill: 0.85, head: 2.35 },
      { type: 'window', c: 9.1, w: 0.9, sill: 1.5, head: 2.3 },
      { type: 'window', c: 11.4, w: 1.1, sill: 0.85, head: 2.35 },
    ],
  },
  {
    ax: 12.6, az: 0, bx: 12.6, bz: 8.4, t: T, label: '东外墙',
    openings: [{ type: 'window', c: 6.2, w: 1.3, sill: 1.0, head: 2.3 }],
  },
  {
    ax: 12.6, az: 8.4, bx: 0, bz: 8.4, t: T, label: '南外墙',
    openings: [
      { type: 'door', c: 12.6 - 3.2, w: 2.4, head: 2.4 }, // 客厅通阳台的推拉门
      { type: 'door', c: 12.6 - 1.4, w: 1.05, head: 2.1 }, // 入户门
      { type: 'window', c: 12.6 - 10.6, w: 1.2, sill: 1.0, head: 2.3 }, // 厨房窗
    ],
  },
  {
    ax: 0, az: 8.4, bx: 0, bz: 0, t: T, label: '西外墙',
    openings: [{ type: 'window', c: 2.6, w: 1.6, sill: 0.85, head: 2.35 }],
  },

  // ── 内墙：卧室区与客厅之间 ──
  {
    ax: 0, az: 3.6, bx: 12.6, bz: 3.6, t: TI, label: '横向内墙',
    openings: [
      { type: 'door', c: 1.9, w: 0.92 }, // 主卧
      { type: 'door', c: 5.9, w: 0.92 }, // 次卧
      { type: 'door', c: 9.1, w: 0.8 },  // 卫生间
      { type: 'door', c: 11.4, w: 0.88 }, // 书房
    ],
  },

  // ── 内墙：卧室之间的隔墙 ──
  { ax: 4.0, az: 0, bx: 4.0, bz: 3.6, t: TI, label: '主卧/次卧隔墙' },
  { ax: 8.0, az: 0, bx: 8.0, bz: 3.6, t: TI, label: '次卧/卫生间隔墙' },
  { ax: 10.2, az: 0, bx: 10.2, bz: 3.6, t: TI, label: '卫生间/书房隔墙' },

  // ── 内墙：厨房隔墙（带一个大开口）──
  {
    ax: 8.6, az: 3.6, bx: 8.6, bz: 8.4, t: TI, label: '厨房隔墙',
    openings: [{ type: 'door', c: 1.6, w: 1.8, head: 2.4 }],
  },
]

export const SAMPLE_SPAWN = { x: 5.4, z: 6.4, yaw: Math.PI * 0.15 }

/* ─────────────────── 家具 ─────────────────── */

function fab(color) {
  return new THREE.MeshStandardMaterial({
    map: fabricTexture(color[0], color[1], color[2]),
    roughness: 0.92,
    metalness: 0,
  })
}

function wood(color = 0xa98763, rough = 0.6) {
  return new THREE.MeshStandardMaterial({
    color,
    map: woodFloorTexture(),
    roughness: rough,
    metalness: 0.02,
  })
}

function stone() {
  return new THREE.MeshStandardMaterial({ map: marbleTexture(), roughness: 0.16, metalness: 0.03 })
}

function metal(color = 0xb9bcc0) {
  return new THREE.MeshStandardMaterial({
    color,
    map: brushedMetalTexture(),
    roughness: 0.34,
    metalness: 0.72,
  })
}

function plain(color, rough = 0.7) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.03 })
}

/** 造一个盒子。尺寸按 (宽 x, 高 y, 深 z)，位置是中心点。 */
function box(x, y, z, w, h, d, material, { collide = true, ry = 0 } = {}) {
  const g = new THREE.BoxGeometry(w, h, d)
  const m = new THREE.Mesh(g, material)
  m.position.set(x, y, z)
  if (ry) m.rotation.y = ry
  m.castShadow = true
  m.receiveShadow = true
  if (!collide) m.userData.noCollide = true
  return m
}

/** 落地家具：给 (中心x, 中心z, 宽, 深, 高)，自动算 y */
function standing(x, z, w, d, h, material, opts = {}) {
  return box(x, h / 2, z, w, h, d, material, opts)
}

function group(name) {
  const g = new THREE.Group()
  g.name = name
  return g
}

function buildBed(x, z, w, len, ry = 0) {
  const g = group('bed')
  const frame = wood(0x8f7150, 0.7)
  const mattress = fab([238, 236, 231])
  const sheet = fab([196, 208, 220])
  const pillow = fab([246, 246, 244])

  g.add(box(0, 0.16, 0, w + 0.1, 0.32, len + 0.1, frame))
  g.add(box(0, 0.42, 0.04, w, 0.22, len - 0.06, mattress))
  g.add(box(0, 0.55, len * 0.18, w + 0.02, 0.06, len * 0.55, sheet))
  for (const px of w > 1.4 ? [-w * 0.26, w * 0.26] : [0]) {
    g.add(box(px, 0.6, -len * 0.32, w * 0.42, 0.14, 0.44, pillow))
  }
  g.add(box(0, 0.62, -len / 2 - 0.03, w + 0.12, 0.95, 0.09, frame)) // 床头板
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildSofa(x, z, w, ry = 0) {
  const g = group('sofa')
  const m = fab([132, 146, 160])
  const legs = metal(0x3a3d42)
  const d = 0.9
  g.add(box(0, 0.2, 0, w, 0.4, d, m))
  g.add(box(0, 0.52, -d / 2 + 0.11, w, 0.62, 0.22, m)) // 靠背
  g.add(box(-w / 2 + 0.11, 0.46, 0, 0.22, 0.3, d - 0.06, m)) // 扶手
  g.add(box(w / 2 - 0.11, 0.46, 0, 0.22, 0.3, d - 0.06, m))
  // 靠垫
  const cush = fab([150, 162, 174])
  const n = Math.max(2, Math.round(w / 0.75))
  for (let i = 0; i < n; i++) {
    const px = -w / 2 + (w / n) * (i + 0.5)
    g.add(box(px, 0.44, 0.02, w / n - 0.08, 0.14, d - 0.3, cush))
  }
  for (const sx of [-1, 1]) {
    g.add(box(sx * (w / 2 - 0.3), 0.07, 0, 0.06, 0.14, 0.06, legs))
    g.add(box(sx * (w / 2 - 0.3), 0.07, d / 2 - 0.2, 0.06, 0.14, 0.06, legs))
  }
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildTable(x, z, w, d, h, ry = 0) {
  const g = group('table')
  const m = wood(0xb08a5e, 0.45)
  g.add(box(0, h - 0.03, 0, w, 0.06, d, m))
  const inset = 0.08
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(box(sx * (w / 2 - inset), (h - 0.06) / 2, sz * (d / 2 - inset), 0.06, h - 0.06, 0.06, metal(0x4a4d52)))
    }
  }
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildChair(x, z, ry = 0) {
  const g = group('chair')
  const m = fab([96, 104, 112])
  const fr = metal(0x53575c)
  g.add(box(0, 0.45, 0, 0.45, 0.06, 0.45, m))
  g.add(box(0, 0.72, -0.2, 0.45, 0.5, 0.06, m))
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(box(sx * 0.18, 0.22, sz * 0.18, 0.035, 0.44, 0.035, fr))
    }
  }
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildWardrobe(x, z, w, ry = 0) {
  const g = group('wardrobe')
  const m = wood(0xc4b39c, 0.55)
  const d = 0.6
  const h = 2.2
  g.add(box(0, h / 2, 0, w, h, d, m))
  // 门缝
  const line = plain(0x9a8b76, 0.6)
  const doors = Math.max(2, Math.round(w / 0.5))
  for (let i = 1; i < doors; i++) {
    g.add(box(-w / 2 + (w / doors) * i, h / 2, d / 2 + 0.005, 0.012, h - 0.08, 0.008, line, { collide: false }))
  }
  // 拉手
  for (let i = 0; i < doors; i++) {
    const px = -w / 2 + (w / doors) * (i + 0.5)
    g.add(box(px, 1.05, d / 2 + 0.02, 0.03, 0.24, 0.02, metal(0x9ba0a6), { collide: false }))
  }
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildCounter(x, z, w, d, ry = 0) {
  const g = group('counter')
  const body = plain(0xe6e2da, 0.6)
  const top = stone()
  const h = 0.88
  g.add(box(0, (h - 0.04) / 2, 0, w, h - 0.04, d, body))
  g.add(box(0, h - 0.02, 0, w + 0.03, 0.04, d + 0.02, top))
  // 门板
  const dark = plain(0x8d949c, 0.5)
  const n = Math.max(1, Math.round(w / 0.6))
  for (let i = 0; i < n; i++) {
    const px = -w / 2 + (w / n) * (i + 0.5)
    g.add(box(px, (h - 0.06) / 2, d / 2 + 0.008, w / n - 0.03, h - 0.12, 0.016, dark, { collide: false }))
  }
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildFridge(x, z, ry = 0) {
  const g = group('fridge')
  const m = metal(0xc8ccd0)
  g.add(box(0, 0.85, 0, 0.72, 1.7, 0.7, m))
  g.add(box(0.16, 1.25, 0.36, 0.03, 0.7, 0.03, metal(0x8d9298), { collide: false }))
  g.add(box(0.16, 0.55, 0.36, 0.03, 0.4, 0.03, metal(0x8d9298), { collide: false }))
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildTV(x, z, w, ry = 0) {
  const g = group('tv')
  const cab = wood(0x6f5a44, 0.5)
  g.add(box(0, 0.24, 0, w, 0.48, 0.42, cab))
  g.add(box(0, 0.95, 0.04, 1.35, 0.78, 0.05, plain(0x14161a, 0.35)))
  g.add(box(0, 0.95, 0.02, 1.28, 0.71, 0.02, plain(0x243040, 0.15), { collide: false }))
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildToilet(x, z, ry = 0) {
  const g = group('toilet')
  const m = plain(0xf6f7f8, 0.18)
  g.add(box(0, 0.2, 0, 0.4, 0.4, 0.55, m))
  g.add(box(0, 0.62, -0.2, 0.42, 0.44, 0.2, m))
  g.add(box(0, 0.42, 0.24, 0.42, 0.06, 0.44, m))
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildBasin(x, z, w, ry = 0) {
  const g = group('basin')
  g.add(box(0, 0.42, 0, w, 0.84, 0.52, plain(0xe9e6e0, 0.55)))
  g.add(box(0, 0.86, 0, w + 0.04, 0.04, 0.54, stone()))
  g.add(box(0, 0.95, -0.06, w * 0.55, 0.1, 0.34, plain(0xffffff, 0.15)))
  g.add(box(0, 1.05, -0.2, 0.04, 0.2, 0.04, metal(0xb6bbc0), { collide: false }))
  g.add(box(0, 1.5, -0.22, w * 0.8, 0.7, 0.02, plain(0xd7e6ef, 0.05), { collide: false }))
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildShower(x, z, w, d) {
  const g = group('shower')
  const tray = plain(0xf0f1f2, 0.25)
  g.add(box(0, 0.03, 0, w, 0.06, d, tray, { collide: false }))
  const glass = glassMaterial()
  g.add(box(w / 2, 1.0, 0, 0.02, 1.9, d, glass, { collide: false }))
  g.add(box(0, 1.0, d / 2, w, 1.9, 0.02, glass, { collide: false }))
  g.add(box(0, 1.95, 0, w, 0.06, d, metal(0xc3c7cb), { collide: false }))
  g.add(box(-w / 2 + 0.12, 1.6, -d / 2 + 0.12, 0.05, 0.4, 0.05, metal(0xd0d4d8), { collide: false }))
  g.position.set(x, 0, z)
  return g
}

function buildShelf(x, z, w, h, ry = 0) {
  const g = group('shelf')
  const m = wood(0xa08a70, 0.6)
  g.add(box(0, h / 2, 0, w, h, 0.32, m))
  const bookMats = [plain(0xb45b4a, 0.8), plain(0x4a6b8a, 0.8), plain(0x7a8b5a, 0.8), plain(0xd0c39a, 0.8)]
  const rows = Math.max(2, Math.floor(h / 0.42))
  for (let r = 1; r < rows; r++) {
    const y = (h / rows) * r
    g.add(box(0, y, 0.16, w - 0.06, 0.03, 0.3, m, { collide: false }))
    // 摆几本书
    let bx = -w / 2 + 0.12
    let k = (r * 7) % 4
    while (bx < w / 2 - 0.12) {
      const bw = 0.03 + ((k % 3) * 0.012)
      g.add(box(bx, y + 0.12, 0.16, bw, 0.21, 0.22, bookMats[k % 4], { collide: false }))
      bx += bw + 0.012
      k++
    }
  }
  g.position.set(x, 0, z)
  g.rotation.y = ry
  return g
}

function buildRug(x, z, w, d, r, g2, b, ry = 0) {
  const geo = new THREE.BoxGeometry(w, 0.012, d)
  const mat = new THREE.MeshStandardMaterial({ map: carpetTexture(r, g2, b), roughness: 1, metalness: 0 })
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, 0.008, z)
  m.rotation.y = ry
  m.receiveShadow = true
  m.userData.noCollide = true
  return m
}

function buildPlant(x, z) {
  const g = group('plant')
  const pot = plain(0xb5643f, 0.75)
  g.add(box(0, 0.18, 0, 0.34, 0.36, 0.34, pot))
  const leaf = new THREE.MeshStandardMaterial({ color: 0x3f6b3a, roughness: 0.85, metalness: 0, side: THREE.DoubleSide })
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2
    const len = 0.5 + (i % 3) * 0.14
    const leafGeo = new THREE.BoxGeometry(0.06, len, 0.16)
    const m = new THREE.Mesh(leafGeo, leaf)
    m.position.set(Math.cos(a) * 0.12, 0.36 + len / 2, Math.sin(a) * 0.12)
    m.rotation.set(0.5, a, (i % 2 ? 1 : -1) * 0.35)
    m.castShadow = true
    m.userData.noCollide = true
    g.add(m)
  }
  g.position.set(x, 0, z)
  return g
}

export function buildFurniture() {
  const g = group('furniture')

  // ── 主卧 (x 0–4.0, z 0–3.6) ──
  g.add(buildBed(2.0, 1.35, 1.8, 2.05, 0))
  g.add(standing(0.95, 0.4, 0.45, 0.4, 0.52, wood(0x8f7150, 0.6)))
  g.add(standing(3.05, 0.4, 0.45, 0.4, 0.52, wood(0x8f7150, 0.6)))
  g.add(buildWardrobe(3.6, 2.9, 0.8, -Math.PI / 2))
  g.add(buildRug(2.0, 3.0, 2.4, 1.1, 148, 138, 150))

  // ── 次卧 (x 4.0–8.0, z 0–3.6) ──
  g.add(buildBed(5.4, 1.3, 1.5, 2.0, 0))
  g.add(buildWardrobe(7.45, 2.9, 1.6, Math.PI / 2))
  g.add(buildTable(6.6, 1.1, 1.0, 0.5, 0.74))
  g.add(buildChair(6.6, 1.75, Math.PI))

  // ── 卫生间 (x 8.0–10.2, z 0–3.6) ──
  g.add(buildBasin(9.1, 0.45, 1.4, Math.PI))
  g.add(buildToilet(8.55, 1.7, Math.PI / 2))
  g.add(buildShower(9.35, 2.85, 1.5, 1.4))

  // ── 书房 (x 10.2–12.6, z 0–3.6) ──
  g.add(buildTable(11.4, 1.05, 1.5, 0.65, 0.75))
  g.add(buildChair(11.4, 1.8, Math.PI))
  g.add(buildShelf(10.55, 2.9, 1.5, 1.9, Math.PI / 2))
  g.add(buildPlant(12.25, 3.15))

  // ── 客厅 / 餐厅 (x 0–8.6, z 3.6–8.4) ──
  g.add(buildRug(3.4, 5.9, 3.6, 2.6, 156, 150, 140))
  g.add(buildSofa(3.4, 4.75, 2.3, Math.PI))
  g.add(buildSofa(1.55, 6.0, 1.7, -Math.PI / 2))
  g.add(buildTable(3.4, 6.05, 1.15, 0.6, 0.42))
  g.add(buildTV(3.4, 7.95, 2.0, 0))
  g.add(buildPlant(0.45, 7.9))
  g.add(buildTable(6.6, 6.6, 1.5, 0.95, 0.75))
  for (const [dx, dz, ry] of [
    [-0.62, -0.75, 0],
    [0.62, -0.75, 0],
    [-0.62, 0.75, Math.PI],
    [0.62, 0.75, Math.PI],
  ]) {
    g.add(buildChair(6.6 + dx, 6.6 + dz, ry))
  }
  g.add(buildShelf(8.15, 5.2, 1.2, 1.7, -Math.PI / 2))

  // ── 厨房 (x 8.6–12.6, z 3.6–8.4) ──
  g.add(buildCounter(9.6, 4.2, 1.8, 0.62, 0))
  g.add(buildCounter(12.25, 5.6, 1.2, 0.62, -Math.PI / 2))
  g.add(buildCounter(9.9, 8.05, 2.4, 0.62, Math.PI))
  g.add(buildFridge(12.2, 4.15, -Math.PI / 2))
  g.add(buildPlant(9.0, 4.1))

  return g
}

/* ─────────────────── 对外 ─────────────────── */

export function buildSampleHouse() {
  const { root, slab } = buildHouse(SAMPLE_WALLS, { height: 2.85, floorKind: 'wood', cell: 0.08 })
  root.name = 'sample-house'

  // 厨房和卫生间换瓷砖地面
  const tileMat = floorMaterial('tile')
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return
    if (o.userData.isCeiling) return
    if (o.material && o.material.map && o.material.map === floorMaterial('wood').map) {
      o.userData.isWoodFloor = true
    }
  })

  const furniture = buildFurniture()
  // 厨房/卫生间地面局部换成瓷砖（用薄薄一层盖上去，避免重算轮廓）
  const tileLayer = new THREE.Group()
  tileLayer.name = 'tile-floors'
  const areas = [
    { minX: 8.0, maxX: 10.2, minZ: 0, maxZ: 3.6 }, // 卫生间
    { minX: 8.72, maxX: 12.55, minZ: 3.72, maxZ: 8.35 }, // 厨房
  ]
  for (const a of areas) {
    const geo = new THREE.PlaneGeometry(a.maxX - a.minX, a.maxZ - a.minZ)
    geo.rotateX(-Math.PI / 2)
    const uv = geo.attributes.uv
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * ((a.maxX - a.minX) / 1.6), uv.getY(i) * ((a.maxZ - a.minZ) / 1.6))
    }
    const m = new THREE.Mesh(geo, tileMat)
    m.position.set((a.minX + a.maxX) / 2, 0.004, (a.minZ + a.maxZ) / 2)
    m.receiveShadow = true
    m.userData.noCollide = true
    m.userData.hideWithCeiling = false
    tileLayer.add(m)
  }
  root.add(tileLayer)
  root.add(furniture)

  return {
    root,
    slab,
    walls: SAMPLE_WALLS,
    spawn: SAMPLE_SPAWN,
    name: SAMPLE_NAME,
  }
}

/**
 * 把样板间转成户型图编辑器能显示的像素坐标墙段
 * @param {number} ppm 每米多少像素
 */
export function sampleAsPixels(ppm = 56) {
  return SAMPLE_WALLS.map((w) => ({
    ax: w.ax * ppm,
    az: w.az * ppm,
    bx: w.bx * ppm,
    bz: w.bz * ppm,
    t: (w.t || 0.12) * ppm,
    openings: (w.openings || []).map((o) => ({ ...o, c: o.c * ppm, w: o.w * ppm })),
  }))
}
