// 碰撞：把场景里的实体网格做成可射线检测的集合，用「分轴移动 + 滑墙」实现贴墙走。
// 装了 three-mesh-bvh 就用 BVH 加速；没装就用普通 Raycaster，只是慢一点。
import * as THREE from 'three'

let BVH = null
let bvhReady = false

export async function initCollisionBackend() {
  if (bvhReady) return bvhReady
  try {
    const mod = await import('three-mesh-bvh')
    // 全局接管 Mesh.raycast：没有 boundsTree 的网格会自动退回原始实现
    THREE.Mesh.prototype.raycast = mod.acceleratedRaycast
    BVH = mod
    bvhReady = true
  } catch (err) {
    console.warn('[collision] three-mesh-bvh 不可用，使用普通射线检测:', err?.message || err)
    bvhReady = false
  }
  return bvhReady
}

export function hasBVH() {
  return bvhReady
}

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _dir = new THREE.Vector3()

export class CollisionWorld {
  constructor() {
    this.meshes = []
    this.raycaster = new THREE.Raycaster()
    this.raycaster.near = 0
    this.raycaster.far = Infinity
    this.down = new THREE.Vector3(0, -1, 0)
    this.bounds = new THREE.Box3()
    this.triangles = 0
  }

  clear() {
    this.meshes.length = 0
    this.bounds.makeEmpty()
    this.triangles = 0
  }

  /**
   * 收集实体网格。跳过被标记为 noCollide 的（比如天空球、玻璃、灯光辅助物）。
   */
  add(root, { skipInvisible = true, maxTriangles = 3_000_000 } = {}) {
    root.updateMatrixWorld(true)
    const found = []
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return
      if (o.userData.noCollide) return
      if (skipInvisible && o.visible === false) return
      const g = o.geometry
      if (!g || !g.attributes || !g.attributes.position) return
      const count = (g.index ? g.index.count : g.attributes.position.count) / 3
      if (count < 1) return
      found.push({ mesh: o, tris: count })
    })

    // 三角形太多时，优先保留大件（墙、地板），丢掉装饰小物
    let total = found.reduce((s, f) => s + f.tris, 0)
    if (total > maxTriangles) {
      found.sort((a, b) => b.tris - a.tris)
      let acc = 0
      this.meshes = []
      for (const f of found) {
        if (acc + f.tris > maxTriangles) continue
        acc += f.tris
        this.meshes.push(f.mesh)
      }
      console.warn(`[collision] 三角面过多(${total})，只对前 ${this.meshes.length} 个大网格做碰撞`)
      total = acc
    } else {
      this.meshes = found.map((f) => f.mesh)
    }

    this.triangles = total

    if (bvhReady) {
      for (const m of this.meshes) {
        const g = m.geometry
        if (g.boundsTree) continue
        // 小几何体建 BVH 反而更慢
        if (!g.index) {
          try {
            g.setIndex([...Array(g.attributes.position.count).keys()])
          } catch {
            /* 少数几何体无法索引化，跳过 */
          }
        }
        try {
          g.boundsTree = new BVH.MeshBVH(g)
        } catch (err) {
          console.warn('[collision] BVH 构建失败，该网格退回普通检测', err?.message || err)
        }
      }
    }

    for (const m of this.meshes) {
      this.bounds.expandByObject(m)
    }
    return this
  }

  get empty() {
    return this.meshes.length === 0
  }

  /** 单条射线，返回最近命中或 null */
  castFirst(origin, dir, far = Infinity) {
    if (!this.meshes.length) return null
    this.raycaster.set(origin, dir)
    this.raycaster.far = far
    this.raycaster.firstHitOnly = bvhReady
    const hits = this.raycaster.intersectObjects(this.meshes, false)
    return hits.length ? hits[0] : null
  }

  /**
   * 在 (x,z) 处向下探测地面高度。
   * fromY 应当是脚底再往上一点，这样上台阶能被吸上去。
   */
  groundAt(x, z, fromY, maxDrop = 60, maxRise = 0.5) {
    _v1.set(x, fromY + maxRise, z)
    const hit = this.castFirst(_v1, this.down, maxRise + maxDrop)
    return hit ? hit.point.y : null
  }

  /**
   * 头顶上方是否有东西（用来看有没有天花板压着）
   */
  ceilingAt(x, z, fromY, maxUp = 4) {
    _v1.set(x, fromY, z)
    const hit = this.castFirst(_v1, _v2.set(0, 1, 0), maxUp)
    return hit ? hit.point.y : null
  }

  /**
   * 分轴移动 + 滑墙。pos 会被就地修改（y 单位是脚底）。
   * radius: 人的半径；height: 人的身高。返回是否发生了水平碰撞。
   */
  moveAndSlide(pos, dx, dz, radius, height) {
    if (!this.meshes.length) {
      pos.x += dx
      pos.z += dz
      return false
    }
    const offs = this.probeHeights(height, radius)
    let blocked = false

    // 先走 X 再走 Z，这样撞墙时会自然沿着墙滑
    if (Math.abs(dx) > 1e-7) {
      const moved = this.axisMove(pos, dx, 0, radius, offs)
      if (moved < Math.abs(dx) - 1e-4) blocked = true
    }
    if (Math.abs(dz) > 1e-7) {
      const moved = this.axisMove(pos, 0, dz, radius, offs)
      if (moved < Math.abs(dz) - 1e-4) blocked = true
    }
    return blocked
  }

  probeHeights(height, radius) {
    const eye = Math.max(radius * 1.2, Math.min(height - radius * 0.6, height - 0.05))
    return [Math.min(height * 0.35, eye), height * 0.55, eye].filter((v, i, a) => a.indexOf(v) === i)
  }

  axisMove(pos, dx, dz, radius, offsets) {
    const dist = Math.hypot(dx, dz)
    if (dist < 1e-9) return 0
    const sign = Math.sign(dx || dz)
    _dir.set(dx / dist, 0, dz / dist)
    let allowed = dist

    for (const oy of offsets) {
      _v1.set(pos.x, pos.y + oy, pos.z)
      const hit = this.castFirst(_v1, _dir, dist + radius)
      if (!hit) continue
      // 起点已经在几何体里（异常模型），放行以免卡死
      if (hit.distance < 0.01) continue
      const free = hit.distance - radius
      if (free < 0) {
        // 已经贴住了，这一轴就别动了
        allowed = 0
        break
      }
      if (free < allowed) allowed = free
    }

    pos.x += (dx / dist) * allowed
    pos.z += (dz / dist) * allowed
    return allowed
  }

  /**
   * 把一个点从墙里推出来（防止在某些模型里出生即卡住）
   */
  pushOut(pos, radius = 0.35, height = 1.7, steps = 8) {
    if (!this.meshes.length) return false
    const offs = this.probeHeights(height, radius)
    const dirs = 12
    let pushed = false
    for (const oy of offs) {
      _v1.set(pos.x, pos.y + oy, pos.z)
      let nearest = null
      let nearestDist = Infinity
      for (let i = 0; i < dirs; i++) {
        const a = (i / dirs) * Math.PI * 2
        _dir.set(Math.cos(a), 0, Math.sin(a))
        const hit = this.castFirst(_v1, _dir, radius * 1.6)
        if (hit && hit.distance < nearestDist) {
          nearest = a
          nearestDist = hit.distance
        }
      }
      if (nearest !== null && nearestDist < radius) {
        // 朝反方向推出去
        const push = radius - nearestDist + 0.02
        pos.x -= Math.cos(nearest) * push
        pos.z -= Math.sin(nearest) * push
        pushed = true
      }
    }
    return pushed
  }
}
