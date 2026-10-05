// 光照与环境。
// 目标：不开 HDR 贴图也让屋子里亮起来，同时能看出材质质感。
// 注意：three r155 之后灯光默认按物理单位计算，强度数值要比老代码大不少。
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { skyGradientTexture } from './textures.js'

export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer
    this.scene = scene
    this.pmrem = null
    this.envRT = null

    this.sun = new THREE.DirectionalLight(0xfff2df, 2.6)
    this.sun.position.set(18, 26, 12)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.035
    const sc = this.sun.shadow.camera
    sc.left = -30
    sc.right = 30
    sc.top = 30
    sc.bottom = -30
    sc.near = 0.5
    sc.far = 160
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)

    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x6b6357, 0.85)
    this.scene.add(this.hemi)

    // 补一盏很弱的全局环境光，防止背光角落全黑
    this.ambient = new THREE.AmbientLight(0xffffff, 0.22)
    this.scene.add(this.ambient)

    this.sky = null
    this.skyMat = null
    this._quality = 2
  }

  /** 生成基于 RoomEnvironment 的 IBL，不依赖任何外部贴图 */
  buildIBL() {
    if (this.envRT) return
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    pmrem.compileEquirectangularShader()
    const room = new RoomEnvironment()
    this.envRT = pmrem.fromScene(room, 0.02)
    this.scene.environment = this.envRT.texture
    this.scene.environmentIntensity = 0.85
    room.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose?.()
      if (o.material) o.material.dispose?.()
    })
    pmrem.dispose()
    this.pmrem = pmrem
  }

  buildSky() {
    if (this.sky) return
    const tex = skyGradientTexture()
    const geo = new THREE.SphereGeometry(1400, 32, 24)
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
    this.sky = new THREE.Mesh(geo, mat)
    this.sky.userData.noCollide = true
    this.sky.renderOrder = -1000
    this.skyMat = mat
    this.scene.add(this.sky)
  }

  /** 让阳光尽量罩住整栋房子，阴影才不会有明显的截断 */
  fitToBounds(box, { shadow = true } = {}) {
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.x, size.z, 6) * 0.62
    const height = Math.max(8, size.y + 6)

    this.sun.target.position.set(center.x, box.min.y, center.z)
    this.sun.position.set(center.x + radius * 0.9, box.min.y + height * 2.2, center.z + radius * 0.7)

    const sc = this.sun.shadow.camera
    sc.left = -radius
    sc.right = radius
    sc.top = radius
    sc.bottom = -radius
    sc.near = 0.5
    sc.far = height * 6 + 40
    sc.updateProjectionMatrix()

    this.sun.castShadow = shadow
    this.hemi.position.set(center.x, box.max.y + 4, center.z)
    this.ambient.position.set(center.x, box.max.y, center.z)

    if (this.sky) this.sky.position.set(center.x, box.min.y, center.z)
    return this
  }

  setQuality(level) {
    this._quality = level
    if (level <= 1) {
      this.sun.castShadow = false
      this.sun.shadow.mapSize.set(1024, 1024)
      this.scene.environmentIntensity = 0.7
    } else if (level === 2) {
      this.sun.castShadow = true
      this.sun.shadow.mapSize.set(1024, 1024)
      this.scene.environmentIntensity = 0.85
    } else {
      this.sun.castShadow = true
      this.sun.shadow.mapSize.set(2048, 2048)
      this.scene.environmentIntensity = 1.0
    }
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose()
      this.sun.shadow.map = null
    }
  }

  setBrightness(id) {
    // 画面偏暗时用户可以切「亮一些」或「真实」
    if (id === 'bright') {
      this.ambient.intensity = 0.55
      this.hemi.intensity = 1.25
      this.scene.environmentIntensity = 1.15
    } else {
      this.ambient.intensity = 0.22
      this.hemi.intensity = 0.85
      this.scene.environmentIntensity = 0.85
    }
  }

  /**
   * 外面的地面。
   * 注意：这块地是要能站人的 —— 走出门口应该站在院子里，而不是掉下去再被送回起点。
   */
  buildGround(radius = 200, y = 0) {
    // 半径变化时必须重建几何体。以前这里只要 this.ground 存在就直接返回缓存的
    // mesh 并只改 y，于是 init 时的 buildGround(220) 把半径永久钉死为 220，之后
    // moveGroundTo(center, 180, ...) 请求的半径被静默丢弃：外景地面永远停在半径
    // 220（直径 440），「按模型尺寸自适应地面」这条逻辑实际从未生效。
    if (this.ground) {
      const currentRadius = this.ground.userData.radius
      if (Math.abs(currentRadius - radius) < 1e-6) {
        this.ground.position.y = y
        return this.ground
      }
      this.scene.remove(this.ground)
      this.ground.geometry.dispose()
      this.ground = null
    }
    const geo = new THREE.CircleGeometry(radius, 48)
    geo.rotateX(-Math.PI / 2)
    const mat = this.groundMat || new THREE.MeshStandardMaterial({ color: 0x8f9285, roughness: 1, metalness: 0 })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.y = y
    mesh.receiveShadow = true
    mesh.name = 'outdoor-ground'
    mesh.userData.radius = radius
    this.ground = mesh
    this.groundMat = mat
    this.scene.add(mesh)
    return mesh
  }

  moveGroundTo(center, radius, y = 0) {
    const g = this.buildGround(radius, y)
    g.position.set(center.x, y, center.z)
    return g
  }

  setSunAzimuth(deg) {
    const r = this.sun.position.length() || 30
    const a = (deg * Math.PI) / 180
    const h = this.sun.position.y
    this.sun.position.set(Math.cos(a) * r * 0.7, h, Math.sin(a) * r * 0.7)
  }

  dispose() {
    this.scene.remove(this.sun, this.hemi, this.ambient)
    if (this.sky) {
      this.scene.remove(this.sky)
      this.sky.geometry.dispose()
      this.skyMat.dispose()
    }
    if (this.ground) {
      this.scene.remove(this.ground)
      this.ground.geometry.dispose()
      this.groundMat.dispose()
    }
    if (this.envRT) {
      this.envRT.dispose()
      this.scene.environment = null
    }
  }
}
