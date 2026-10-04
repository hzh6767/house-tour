// 总装。把渲染、玩家、碰撞、小地图、UI 串起来。
import * as THREE from 'three'
import { $, $$, toast, clamp, damp, b64decode, b64encode, isTouch, isMobile, detectQuality, formatBytes, copyText, baseName, stripExt } from './util.js'
import { Environment } from './env.js'
import { CollisionWorld, initCollisionBackend, hasBVH } from './collision.js'
import { Player, Joystick } from './player.js'
import { Minimap, planFromGrid, planFromWalls } from './minimap.js'
import { buildHouse } from './walls.js'
import { buildSampleHouse, SAMPLE_NAME } from './sample.js'
import { PlanEditor } from './plan.js'
import { bakeFootprint } from './raster.js'
import { loadModelFile, loadModelUrl, disposeLoaded, setRenderer, MODEL_EXT } from './loader.js'

const QUALITY_NAMES = ['自动', '流畅', '均衡', '精细']

class App {
  constructor() {
    this.canvas = $('#view')
    if (!this.canvas) throw new Error('Canvas element #view not found')
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0b0d10)

    this.quality = detectQuality()
    this.autoQuality = true
    this.qualityExplicit = 0

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !isMobile(),
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    })
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    setRenderer(this.renderer)

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.06, 900)
    this.camera.userData.domElement = this.canvas

    this.env = new Environment(this.renderer, this.scene)
    this.collision = new CollisionWorld()
    this.player = new Player(this.camera, this.collision, {
      walkSpeed: 3.2,
      eyeHeight: 1.65,
    })

    this.sceneRoot = new THREE.Group()
    this.sceneRoot.name = 'content'
    this.scene.add(this.sceneRoot)

    this.current = null // { root, kind:'sample'|'model'|'plan', walls?, spawn? }
    this.plan = new PlanEditor(this)
    this.minimap = new Minimap($('#minimap'))

    this.fps = 0
    this._frameTimes = []
    this._autoTuneAt = 0
    this._tuneIdx = 0
    this._tuneLadder = []

    this._last = performance.now()
    this._hinted = new Set()
    this._footprintPending = null
    this._footprintCell = 0.1
    this.ready = false
    // 太阳位置的基准偏移，finalizeScene 里会按场景尺寸重算
    this._sunOffset = new THREE.Vector3(18, 26, 12)

    this.settings = this.loadSettings()
  }

  /* ══════════════ 初始化 ══════════════ */

  async init() {
    await initCollisionBackend()

    this.renderer.setPixelRatio(this.pixelRatio())
    this.resize()
    window.addEventListener('resize', () => this.resize())

    this.env.buildIBL()
    this.env.buildSky()
    this.env.buildGround(220)
    this.env.setQuality(this.quality)

    this.applySettings()
    this.bindUI()
    this.bindMinimap()
    this.bindJoystick()

    const note = $('#runtime-note')
    if (note) {
      note.textContent = `渲染器就绪 · 碰撞${hasBVH() ? '已加速(BVH)' : '未加速'} · 画质档位 ${QUALITY_NAMES[this.quality]}${isTouch() ? ' · 触屏模式' : ''}`
    }

    this.player.enabled = false
    this.renderer.setAnimationLoop(() => this.frame())

    // 从 URL 直接载入（分享链接用）
    await this.handleDeepLink()

    // 拉一下服务器上已有的模型
    this.refreshRecent()

    this.updateStatsLine()
  }

  pixelRatio() {
    const cap = this.quality <= 1 ? 1.15 : this.quality === 2 ? 1.6 : 2
    return Math.min(window.devicePixelRatio || 1, cap)
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.minimap?.resize()
  }

  /* ══════════════ 主循环 ══════════════ */

  frame() {
    const now = performance.now()
    const dt = Math.min((now - this._last) / 1000, 0.1)
    this._last = now

    // 帧率统计
    if (dt > 0) {
      this._frameTimes.push(1 / dt)
      if (this._frameTimes.length > 60) this._frameTimes.shift()
      let sum = 0
      for (const f of this._frameTimes) sum += f
      this.fps = sum / this._frameTimes.length
    }

    this.player.update(dt)

    // 让太阳的阴影相机跟着玩家走，走到哪阴影都在
    const p = this.player.position
    this.env.sun.position.set(p.x + this._sunOffset.x, this._sunOffset.y, p.z + this._sunOffset.z)
    this.env.sun.target.position.set(p.x, p.y, p.z)
    this.env.sun.target.updateMatrixWorld()
    if (this.env.sky) this.env.sky.position.set(p.x, this.env.sky.position.y, p.z)

    this.renderer.render(this.scene, this.camera)

    if (this.ready && !$('#minimap-wrap').hidden) {
      this.minimap.draw(this.player.position, this.player.yaw, { fov: this.camera.fov })
    }

    this.autoTune(now)
  }

  autoTune(now) {
    if (!this.autoQuality || now < this._autoTuneAt) return
    if (this._frameTimes.length < 45) return
    this._autoTuneAt = now + 2200

    if (this.fps < 26 && this.quality > 0) {
      this.setQuality(this.quality - 1, { auto: true })
    } else if (this.fps > 58 && this.quality < 3) {
      // 慢慢往上试，别来回抖
      this._tuneIdx++
      if (this._tuneIdx >= 3) {
        this._tuneIdx = 0
        this.setQuality(this.quality + 1, { auto: true })
      }
    } else {
      this._tuneIdx = 0
    }
    this.updateStatsLine()
  }

  setQuality(level, opts = {}) {
    level = clamp(Math.round(level), 0, 3)
    const prev = this.quality
    this.quality = level
    if (!opts.auto) {
      this.autoQuality = false
      this.qualityExplicit = level
      this.settings.quality = level
      this.saveSettings()
    }
    if (level === prev && !opts.force) return

    this.renderer.setPixelRatio(this.pixelRatio())
    this.resize()
    this.env.setQuality(level === 0 ? 1 : level)
    this.renderer.shadowMap.enabled = level >= 2

    // 改完阴影设置要让材质重新编译
    this.scene.traverse((o) => {
      if (o.material) {
        const list = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of list) if (m) m.needsUpdate = true
      }
    })

    const q = $('#s-q')
    if (q && opts.auto) q.value = String(level)
    const lbl = $('#v-q')
    if (lbl) lbl.textContent = QUALITY_NAMES[level] + (this.autoQuality ? '' : ' (手动)')
    this.updateStatsLine()
  }

  /* ══════════════ 场景装载 ══════════════ */

  _clearScene() {
    if (this.current) {
      disposeLoaded(this.current.loaded ?? this.current)
      this.sceneRoot.remove(this.current.root)
      this.current = null
    }
    this.collision.clear()
    this.minimap.setPlan(null)
    $('#minimap-wrap').hidden = true
    // 不清掉的话，返回启动页后面板里还会显示上一个模型的尺寸和面数
    this.sceneInfo = null
    this.ready = false
  }

  /** 通用：把 root 装进场景并做碰撞、地图、出生点 */
  finalizeScene({ root, kind, name, walls = null, spawn = null, loaded = null, footprint = null }) {
    this.sceneRoot.add(root)
    root.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(root)
    if (box.isEmpty()) throw new Error('场景里没有可用的几何体')
    const size = box.getSize(new THREE.Vector3())

    const center = box.getCenter(new THREE.Vector3())

    // 外景地面。做成能踩的：从门口走出去应该站在院子里，而不是掉进虚空。
    // 高度贴着房子底部再下移 3cm，避免与室内地板共面时闪面。
    const groundMesh = this.env.moveGroundTo(
      center,
      Math.max(180, Math.max(size.x, size.z) * 6),
      box.min.y - 0.03
    )
    this.sceneRoot.add(groundMesh)

    // 碰撞集合（连地面一起收进来）
    this.collision.clear()
    this.collision.add(this.sceneRoot)

    // 光照范围
    this.env.fitToBounds(box)
    this._sunOffset = new THREE.Vector3(
      box.min.x - center.x + Math.max(size.x, 8) * 0.9,
      Math.max(14, size.y + 16),
      Math.max(size.z, 8) * 0.7
    )

    // 出生点
    let sp
    if (spawn) {
      sp = new THREE.Vector3(spawn.x, 0, spawn.z)
    } else {
      sp = this.findSpawn(box)
    }
    const g = this.collision.empty ? null : this.collision.groundAt(sp.x, sp.z, box.max.y + 2, 400, 0.5)
    sp.y = g !== null ? g + 0.05 : box.min.y
    this.player.placeAt(sp, spawn?.yaw ?? 0)
    if (!this.collision.empty) this.collision.pushOut(this.player.position, this.player.radius, this.player.height)
    // 出生点如果悬空，往下吸到地面
    if (!this.collision.empty) {
      const g2 = this.collision.groundAt(this.player.position.x, this.player.position.z, this.player.position.y + 2, 400, 0.5)
      if (g2 !== null) this.player.position.y = g2
      this.player.spawn.copy(this.player.position)
    }

    // 小地图数据
    if (walls && walls.length) {
      this.minimap.setPlan(planFromWalls(walls))
      $('#minimap-wrap').hidden = false
    } else if (footprint) {
      this.minimap.setPlan(planFromGrid(footprint.grid, footprint.bounds))
      $('#minimap-wrap').hidden = false
    } else {
      $('#minimap-wrap').hidden = true
    }

    this.current = { root, kind, name, walls, loaded }
    this.ready = true

    // 名字
    const placeName = $('#place-name')
    if (placeName) placeName.textContent = name || '未命名空间'

    // 天花板显示开关
    this.applyCeilingVisibility()

    // 更新面板里的信息
    this.sceneInfo = {
      kind,
      name,
      size,
      triangles: this.collision.triangles,
      meshes: this.collision.meshes.length,
      stats: loaded?.stats || null,
      autoScale: loaded?.autoScale || 1,
      bytes: loaded?.sizeBytes ?? loaded?.rawBytes ?? null,
    }
    this.updateStatsLine()

    // 隐藏启动面板，开始走
    this.hideSheets()
    this.player.enabled = true
    this.showHint('点击画面锁定鼠标，WASD 走动')
    this.requestLockSoon()
  }

  findSpawn(box) {
    const center = box.getCenter(new THREE.Vector3())
    if (this.collision.empty) return new THREE.Vector3(center.x, box.min.y, center.z)

    // 从中心向外撒一圈候选点，挑「站得住」的那个。
    // 关键：取地面最低的候选点 —— 家具顶面比地板高，取最低就不会出生在茶几上。
    const R = Math.max(1.4, Math.min(Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.18, 3.2))
    const candidates = [
      [0, 0], [R, 0], [-R, 0], [0, R], [0, -R],
      [R * 0.7, R * 0.7], [-R * 0.7, -R * 0.7], [R * 0.7, -R * 0.7], [-R * 0.7, R * 0.7],
      [R * 1.6, 0], [-R * 1.6, 0], [0, R * 1.6], [0, -R * 1.6],
    ]

    let best = null
    for (const [dx, dz] of candidates) {
      const x = center.x + dx
      const z = center.z + dz
      const g = this.collision.groundAt(x, z, box.max.y + 2, 400, 0.5)
      if (g === null) continue
      // 头顶要留得下一个人
      const ceil = this.collision.ceilingAt(x, g + 0.2, g + 0.2, 3.2)
      if (ceil !== null && ceil - g < 1.8) continue
      if (!best || g < best.y) best = new THREE.Vector3(x, g, z)
    }
    // 一个候选点都不行时，退回中心
    return best || new THREE.Vector3(center.x, box.min.y, center.z)
  }

  requestLockSoon() {
    if (isTouch()) return
    const el = this.canvas
    // 先撤掉上一次还没触发的监听，否则连续载入几个场景会叠好几个，
    // 用户第一次点击时会把 requestLock 连调多次
    if (this._lockSoonHandler) {
      window.removeEventListener('pointerdown', this._lockSoonHandler)
      this._lockSoonHandler = null
    }
    const once = () => {
      this._lockSoonHandler = null
      this.player.requestLock()
      window.removeEventListener('pointerdown', once)
    }
    this._lockSoonHandler = once
    // 用户不点就不锁，浏览器不允许
    window.addEventListener('pointerdown', once, { once: true })
    void el
  }

  loadSample() {
    this.showLoading('正在搭建样品房…')
    this._clearScene()
    setTimeout(() => {
      try {
        const s = buildSampleHouse()
        this.finalizeScene({
          root: s.root,
          kind: 'sample',
          name: SAMPLE_NAME,
          walls: s.walls,
          spawn: s.spawn,
        })
        this.hideLoading()
        toast('样板间已就绪 · 试试从客厅走到主卧')
      } catch (err) {
        this.hideLoading()
        this.fail(err)
      }
    }, 30)
  }

  buildFromPlan(walls, opts = {}) {
    this.showLoading('正在生成 3D 空间…')
    this._clearScene()
    setTimeout(() => {
      try {
        const height = opts.height ?? this.plan.wallHeight
        const { root, slab } = buildHouse(walls, {
          height,
          floorKind: opts.floorKind || 'wood',
          cell: 0.08,
          thickness: opts.thickness || 0.12,
        })

        if (!slab.interiorTiles) {
          // 墙没围成一个封闭空间，铺一层包围盒大小的大地板兜底
          const g = new THREE.PlaneGeometry(
            (slab.bounds.maxX - slab.bounds.minX) + 2,
            (slab.bounds.maxZ - slab.bounds.minZ) + 2
          )
          g.rotateX(-Math.PI / 2)
          const m = new THREE.Mesh(
            g,
            new THREE.MeshStandardMaterial({ color: 0xb9b3a8, roughness: 0.9, metalness: 0 })
          )
          m.position.set(
            (slab.bounds.minX + slab.bounds.maxX) / 2,
            -0.01,
            (slab.bounds.minZ + slab.bounds.maxZ) / 2
          )
          m.receiveShadow = true
          root.add(m)
        }

        root.name = opts.name || '自建户型'
        this.finalizeScene({
          root,
          kind: 'plan',
          name: opts.name || '自建户型',
          walls,
          spawn: null,
        })
        this.hideLoading()
        toast(`已生成 ${walls.length} 段墙 · 面积约 ${((slab.bounds.maxX - slab.bounds.minX) * (slab.bounds.maxZ - slab.bounds.minZ)).toFixed(1)} ㎡`)
      } catch (err) {
        this.hideLoading()
        this.fail(err)
      }
    }, 30)
  }

  /* ══════════════ 载入模型 ══════════════ */

  async loadFiles(files) {
    const list = Array.from(files || []).filter(Boolean)
    if (!list.length) return

    // 多个文件：可能是 obj + mtl + 贴图，或者被拆开的 gltf
    const main = list.find((f) => MODEL_EXT.includes(extOf(f.name))) || list.find((f) => extOf(f.name) === '.zip')
    if (!main) {
      toast('没找到模型文件，请选择 .glb / .gltf / .obj / .fbx / .zip 等')
      return
    }

    this._lastFile = main
    this.showLoading(`准备载入 ${main.name}`)
    const t0 = performance.now()

    try {
      const loaded = await loadModelFile(main, {
        onStage: (t) => this.setLoadingText(t, ''),
        onProgress: (p, label) => this.setLoadingProgress(p, label),
      })

      this._clearScene()
      this.setLoadingText('整理场景…', '')
      this.setLoadingProgress(96, '')

      // 大模型先在后台烘小地图，不阻塞进入
      this.footprintPending = loaded.object

      this.finalizeScene({
        root: loaded.object,
        kind: 'model',
        name: stripExt(loaded.sourceName || main.name),
        loaded,
      })

      const secs = (performance.now() - t0) / 1000
      this.showHint(`载入完成，用时 ${secs.toFixed(1)} 秒`)
      if (loaded.autoScale !== 1) {
        toast(`模型单位看起来不是米，已自动缩放 ${loaded.autoScale.toFixed(3)} 倍`)
      }
      this.hideLoading()

      // 后台烘俯视图给小地图
      setTimeout(() => this.bakeFootprintAsync(loaded.object), 400)
    } catch (err) {
      this.hideLoading()
      this.fail(err, '模型载入失败')
    }
  }

  async loadUrl(url, opts = {}) {
    this.showLoading(`载入 ${baseName(url)}`)
    try {
      const loaded = await loadModelUrl(url, {
        onStage: (t) => this.setLoadingText(t, ''),
        onProgress: (p, label) => this.setLoadingProgress(p, label),
      })
      this._clearScene()
      this.finalizeScene({
        root: loaded.object,
        kind: 'model',
        name: stripExt(decodeURIComponent(baseName(url))),
        loaded,
      })
      this.hideLoading()
      setTimeout(() => this.bakeFootprintAsync(loaded.object), 400)
    } catch (err) {
      this.hideLoading()
      this.fail(err, '载入失败')
    }
    void opts
  }

  bakeFootprintAsync(root) {
    if (!root || this.current?.root !== root) return
    const run = () => {
      try {
        const fp = bakeFootprint(root, Math.max(0.06, this._footprintCell || 0.1))
        if (!fp) return
        if (this.current?.root !== root) return
        this.minimap.setPlan(planFromGrid(fp.grid, fp.bounds))
        $('#minimap-wrap').hidden = false
      } catch (err) {
        console.warn('[footprint] 生成俯视图失败:', err?.message || err)
      }
    }
    // 用 requestIdleCallback 让出主线程
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 2500 })
    else setTimeout(run, 200)
  }

  fail(err, title = '出错了') {
    console.error(err)
    const msg = err?.message || String(err)
    toast(`${title}：${msg}`, 5200)
    this.showHint(`${title} · ${msg}`, 6000)
    if (!this.current) {
      this.showSheet('#start')
      $('#loading').hidden = true
    }
  }

  /* ══════════════ 加载界面 ══════════════ */

  showLoading(text = '正在载入') {
    $('#loading').hidden = false
    $('#ld-pct').textContent = '0%'
    $('#ld-fill').style.width = '0%'
    $('#ld-file').textContent = ''
    this.setLoadingText(text, '')
  }

  setLoadingText(text, sub) {
    $('#loading').hidden = false
    $('#loading .ld-title').textContent = text
    if (sub !== undefined && sub !== '') $('#ld-file').textContent = sub
  }

  setLoadingProgress(pct, label) {
    const p = clamp(Math.round(pct), 0, 100)
    $('#ld-fill').style.width = p + '%'
    $('#ld-pct').textContent = p + '%'
    if (label) $('#ld-file').textContent = label
  }

  hideLoading() {
    $('#loading').hidden = true
  }

  /* ══════════════ 提示 ══════════════ */

  showHint(text, ms = 4200) {
    const el = $('#hintbar')
    el.hidden = false
    el.classList.remove('fade')
    el.textContent = text
    clearTimeout(this._hintTimer)
    this._hintTimer = setTimeout(() => {
      el.classList.add('fade')
      setTimeout(() => {
        if (el.classList.contains('fade')) el.hidden = true
      }, 400)
    }, ms)
  }

  /* ══════════════ 面板 ══════════════ */

  showSheet(sel) {
    $$('.sheet').forEach((s) => {
      if (s.id !== 'plan-editor') s.hidden = true
    })
    const el = $(sel)
    if (el) el.hidden = false
    if (this.player) {
      this.player.exitLock()
      this.player.enabled = false
    }
  }

  hideSheets() {
    $$('.sheet').forEach((s) => {
      s.hidden = true
    })
    if (this.player) {
      this.player.enabled = true
      $('#toolbar').hidden = false
    }
  }

  updateStatsLine() {
    const el = $('#perf')
    if (!el) return
    const parts = []
    parts.push(`${this.fps.toFixed(0)} FPS`)
    parts.push(`档位 ${QUALITY_NAMES[this.quality]}${this.autoQuality ? '(自动)' : ''}`)
    parts.push(`DPR ${this.renderer.getPixelRatio().toFixed(2)}`)
    if (this.collision.triangles) parts.push(`碰撞面 ${(this.collision.triangles / 1000).toFixed(0)}k`)
    if (this.sceneInfo) {
      const s = this.sceneInfo.size
      parts.push(`空间 ${s.x.toFixed(1)}×${s.z.toFixed(1)}×${s.y.toFixed(1)} m`)
      if (s.autoScale && s.autoScale !== 1) parts.push(`自动缩放 ${s.autoScale.toFixed(3)}×`)
      if (s.stats) parts.push(`${(s.stats.triangles / 1000).toFixed(1)}k 面 / ${s.stats.textures} 贴图`)
    }
    parts.push(isTouch() ? '触屏' : '键鼠')
    el.textContent = parts.join('  ·  ')
  }

  /* ══════════════ UI 绑定 ══════════════ */

  bindUI() {
    // 启动页
    $$('[data-go]').forEach((b) =>
      b.addEventListener('click', () => {
        const go = b.dataset.go
        const fi = $('#file-input')
        if (go === 'model' && fi) fi.click()
        else if (go === 'plan') this.openPlanEditor()
        else if (go === 'sample') this.loadSample()
      })
    )

    const fileInput = $('#file-input')
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        this.loadFiles(fileInput.files)
        fileInput.value = ''
      })
    }

    const dz = $('#dropzone')
    if (dz && fileInput) {
      dz.addEventListener('click', () => fileInput.click())
    }
    for (const type of ['dragenter', 'dragover']) {
      dz.addEventListener(type, (e) => {
        e.preventDefault()
        dz.classList.add('drag')
      })
    }
    for (const type of ['dragleave', 'drop']) {
      dz.addEventListener(type, () => dz.classList.remove('drag'))
    }
    // 整页拖放
    window.addEventListener('dragover', (e) => {
      e.preventDefault()
      $('#start').hidden = false
      dz.classList.add('drag')
    })
    window.addEventListener('drop', (e) => {
      e.preventDefault()
      dz.classList.remove('drag')
      if (e.dataTransfer?.files?.length) this.loadFiles(e.dataTransfer.files)
    })

    // 工具条
    $$('#toolbar [data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act)))
    $$('#menu [data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act)))
    $$('#help [data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act)))

    // 设置滑块
    const s = $('#s-speed')
    s.addEventListener('input', () => {
      this.player.walkSpeed = Number(s.value)
      $('#v-speed').textContent = Number(s.value).toFixed(1)
      this.settings.speed = Number(s.value)
      this.saveSettings()
    })
    const fov = $('#s-fov')
    fov.addEventListener('input', () => {
      this.camera.fov = Number(fov.value)
      this.camera.updateProjectionMatrix()
      $('#v-fov').textContent = fov.value
      this.settings.fov = Number(fov.value)
      this.saveSettings()
    })
    const sens = $('#s-sens')
    sens.addEventListener('input', () => {
      this.player.sensitivity = Number(sens.value)
      $('#v-sens').textContent = Number(sens.value).toFixed(1)
      this.settings.sens = Number(sens.value)
      this.saveSettings()
    })
    const eye = $('#s-eye')
    eye.addEventListener('input', () => {
      this.player.eyeHeight = Number(eye.value)
      $('#v-eye').textContent = Number(eye.value).toFixed(2)
      this.settings.eye = Number(eye.value)
      this.saveSettings()
    })
    const q = $('#s-q')
    q.addEventListener('input', () => {
      const v = Number(q.value)
      if (v === 0) {
        this.autoQuality = true
        this.setQuality(detectQuality(), { force: true })
      } else {
        this.setQuality(v)
      }
      $('#v-q').textContent = QUALITY_NAMES[v] + (v === 0 ? '' : ' (手动)')
      this.settings.quality = v
      this.saveSettings()
    })

    const bind = (id, fn) => {
      const el = $(id)
      el.addEventListener('change', () => {
        fn(el.checked)
        this.settings[id.replace(/^#s-/, '')] = el.checked
        this.saveSettings()
      })
    }
    bind('#s-shadow', (v) => {
      this.env.sun.castShadow = v
      this.renderer.shadowMap.enabled = v
      this.scene.traverse((o) => {
        const list = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
        for (const m of list) if (m) m.needsUpdate = true
      })
      if (v) this.env.setQuality(this.quality)
    })
    bind('#s-bob', (v) => {
      this.player.bobEnabled = v
    })
    bind('#s-map', (v) => {
      $('#minimap-wrap').hidden = !v || !this.minimap.plan
    })
    bind('#s-ceiling', () => this.applyCeilingVisibility())

    // 小地图切换
    $('#mm-mode').addEventListener('click', (e) => {
      e.stopPropagation()
      const m = this.minimap
      const modes = ['俯视', '跟随朝向']
      const cur = m.rotateWithPlayer ? 1 : 0
      const next = (cur + 1) % 2
      m.rotateWithPlayer = next === 1
      $('#mm-mode').textContent = modes[next]
      m.fit()
    })
    $('#minimap').addEventListener('click', (e) => {
      const w = $('#minimap-wrap')
      if (e.shiftKey) {
        w.classList.toggle('big')
        this.minimap.fit()
      }
    })

    // 画布点击 → 锁鼠标
    this.canvas.addEventListener('mousedown', () => {
      if (this.ready && !isTouch() && !this.player.locked) this.player.requestLock()
    })

    // 玩家回调
    this.player.onPointerLockChange = (locked) => {
      $('#crosshair').hidden = !locked
      if (locked && !this._hinted.has('lock')) {
        this._hinted.add('lock')
        this.showHint('WASD 走动 · Shift 快走 · Q/E 升降 · 按 H 看全部操作')
      }
    }
    this.player.onGroundFail = () => toast('掉下去了，已把你送回起点')

    // 键盘快捷键
    window.addEventListener('keydown', (e) => {
      if ($('#plan-editor').hidden === false) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      switch (e.code) {
        case 'KeyH':
          this.act($('#help').hidden ? 'help' : 'close-help')
          break
        case 'KeyR':
          this.player.respawn()
          toast('已回到起点')
          break
        case 'KeyM': {
          const w = $('#minimap-wrap')
          if (w.hidden) {
            w.hidden = false
            this.minimap.fit()
          } else {
            const order = ['', 'mini', 'big']
            const cur = w.classList.contains('big') ? 2 : w.classList.contains('mini') ? 1 : 0
            const next = (cur + 1) % 3
            w.classList.remove('big', 'mini')
            if (order[next]) w.classList.add(order[next])
            this.minimap.fit()
          }
          break
        }
        case 'KeyF':
          this.player.setFly(!this.player.fly)
          toast(this.player.fly ? '自由飞行：Q 下降 / E 上升' : '回到步行模式')
          break
        case 'Escape':
          this.act('close-menu')
          this.act('close-help')
          break
        default:
          break
      }
    })
  }

  applyCeilingVisibility() {
    const el = $('#s-ceiling')
    const show = el ? el.checked : false
    this.sceneRoot.traverse((o) => {
      if (o.userData && (o.userData.isCeiling || o.userData.hideWithCeiling)) o.visible = show
    })
  }

  act(name) {
    switch (name) {
      case 'menu':
        this.showSheet('#menu')
        break
      case 'close-menu':
        if (this.current) this.hideSheets()
        else this.showSheet('#start')
        break
      case 'help':
        this.showSheet('#help')
        break
      case 'close-help':
        if (this.current) this.hideSheets()
        else this.showSheet('#start')
        break
      case 'reset':
        this.player.respawn()
        toast('已回到起点')
        break
      case 'shot':
        this.snapshot()
        break
      case 'full':
        this.toggleFullscreen()
        break
      case 'share':
        this.share()
        break
      case 'upload':
        this.uploadCurrent()
        break
      case 'back':
        this._clearScene()
        this.player.enabled = false
        $('#toolbar').hidden = true
        this.showSheet('#start')
        break
      default:
        break
    }
  }

  /* ══════════════ 截图 / 分享 / 上传 ══════════════ */

  snapshot() {
    try {
      this.renderer.render(this.scene, this.camera)
      const url = this.renderer.domElement.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = `${(this.current?.name || '看房').replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
      a.click()
      toast('截图已保存')
    } catch (err) {
      toast('截图失败：' + (err?.message || err))
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => toast('该浏览器不支持全屏'))
    } else {
      document.exitFullscreen?.()
    }
  }

  async share() {
    const params = new URLSearchParams()
    if (this.current?.kind === 'sample') {
      params.set('s', '1')
    } else if (this.current?.kind === 'plan') {
      const s = this.plan.toShareString()
      if (s.length < 6000) params.set('p', s)
      else {
        toast('户型太复杂，分享链接会很长，建议改用「上传到服务器」')
        return
      }
    } else if (this.current?.loaded?.url) {
      params.set('m', this.current.loaded.url)
    } else {
      toast('这个模型是本地临时载入的，服务器上没有。先用「上传到服务器」再分享')
      return
    }
    const url = location.origin + location.pathname + '?' + params.toString()
    const ok = await copyText(url)
    toast(ok ? '分享链接已复制到剪贴板' : '复制失败，链接是：' + url.slice(0, 80) + '…', ok ? 2400 : 6000)
  }

  async uploadCurrent() {
    const f = this._lastFile
    if (!f) {
      toast('只有从本机拖入的模型才能上传。请重新拖一次文件，或直接放进 models 文件夹')
      return
    }
    this.showLoading('正在上传到服务器…')
    this.setLoadingProgress(5, '')
    try {
      const res = await fetch('/_upload?name=' + encodeURIComponent(f.name), {
        method: 'POST',
        body: f,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
      const text = await res.text()
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`)
      const json = JSON.parse(text)
      this.setLoadingProgress(100, formatBytes(json.size))
      this.hideLoading()
      toast(`已上传，可以分享链接了：${json.url}`)
      if (this.current?.loaded) this.current.loaded.url = json.url
      this.refreshRecent()
    } catch (err) {
      this.hideLoading()
      toast('上传失败：' + (err?.message || err), 5000)
    }
  }

  /* ══════════════ 最近模型 ══════════════ */

  async refreshRecent() {
    const wrap = $('#recent')
    const list = $('#recent-list')
    try {
      const res = await fetch('/_models')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const { models } = await res.json()
      if (!models?.length) {
        wrap.hidden = true
        return
      }
      wrap.hidden = false
      list.innerHTML = ''
      for (const m of models.slice(0, 14)) {
        const b = document.createElement('button')
        b.className = 'rchip'
        const name = document.createElement('span')
        name.textContent = m.name
        const sz = document.createElement('span')
        sz.className = 'sz'
        sz.textContent = formatBytes(m.size)
        b.append(name, sz)
        b.addEventListener('click', () => this.loadUrl(m.url))
        list.appendChild(b)
      }
    } catch {
      wrap.hidden = true
    }
  }

  /* ══════════════ 户型图编辑器 ══════════════ */

  openPlanEditor() {
    this.player.exitLock()
    this.player.enabled = false
    $('#plan-editor').hidden = false
    this.plan.resize()
    this.plan.fitView()
    this.plan.setTool(this.plan.tool)
    this.plan._changed()

    // 绑定一次
    if (!this._planBound) {
      this._planBound = true
      const pe = this.plan

      $$('[data-pe]').forEach((b) =>
        b.addEventListener('click', async () => {
          const a = b.dataset.pe
          if (a === 'pick-image') $('#plan-file').click()
          else if (a === 'gen-demo') pe.loadDemo()
          else if (a === 'undo') pe.undo()
          else if (a === 'clear') {
            pe.push()
            pe.walls = []
            pe._changed()
          } else if (a === 'calib-apply') this.applyCalibration()
          else if (a === 'side-toggle') $('.pe-side')?.classList.toggle('open')
          else if (a === 'close') this.closePlanEditor()
          else if (a === 'build') this.buildFromPlanEditor()
          else if (a === 'fit') {
            pe.fitView()
            pe.draw()
          }
        })
      )

      $$('.tool').forEach((b) => b.addEventListener('click', () => pe.setTool(b.dataset.tool)))
      $('#plan-file').addEventListener('change', (e) => {
        const f = e.target.files?.[0]
        if (f) pe.loadImageFile(f)
        e.target.value = ''
      })

      const h = $('#pe-h')
      h.addEventListener('input', () => {
        pe.wallHeight = Number(h.value)
        $('#pe-hv').textContent = pe.wallHeight.toFixed(2)
      })
      const t = $('#pe-t')
      t.addEventListener('input', () => {
        pe.wallThickness = Number(t.value) * pe.ppm
        $('#pe-tv').textContent = Number(t.value).toFixed(2)
        for (const w of pe.walls) w.t = pe.wallThickness
        pe.draw()
      })
      const d = $('#pe-d')
      d.addEventListener('input', () => {
        pe.doorWidth = Number(d.value) * pe.ppm
        $('#pe-dv').textContent = Number(d.value).toFixed(2)
      })
      $('#pe-snap').addEventListener('change', (e) => {
        pe.snap = e.target.checked
      })
      // 有的版本没有这个开关，存在才绑定
      const floorToggle = $('#pe-floor')
      if (floorToggle) {
        floorToggle.addEventListener('change', (e) => {
          pe.makeFloor = e.target.checked
        })
      }

      // 侧栏里额外标定工具按钮（和画布上的「标定」是同一个工具）
      $$('[data-tool="calibrate"]').forEach((b) =>
        b.addEventListener('click', () => {
          pe.setTool('calibrate')
          toast('在图上点两处已知距离的两端，再填实际米数并点「应用」')
        })
      )

      // 点门洞工具时，先让用户在墙上点一下
      pe.canvas.addEventListener('click', (e) => {
        if (pe.tool !== 'door') return
        const r = pe.canvas.getBoundingClientRect()
        const p = pe.toWorld(e.clientX - r.left, e.clientY - r.top)
        const i = pe.hitWall(p, 14 / pe.view.k)
        if (i === null) {
          toast('请点在墙上')
          return
        }
        const w = pe.walls[i]
        const len = Math.hypot(w.bx - w.ax, w.bz - w.az)
        const c = pe._distOn(w, p)
        const dw = Math.min(pe.doorWidth, len * 0.7)
        if (len - dw < 0.4 * pe.ppm) {
          toast('这段墙太短，开不了门洞')
          return
        }
        pe.push()
        w.openings = w.openings || []
        // 位置和已有的重叠就往旁边挪
        let place = clamp(c, dw / 2 + 0.1 * pe.ppm, len - dw / 2 - 0.1 * pe.ppm)
        for (const o of w.openings) {
          if (Math.abs(o.c - place) < (o.w + dw) / 2) {
            place = clamp(o.c + (o.w + dw) / 2, dw / 2, len - dw / 2)
          }
        }
        w.openings.push({ type: 'door', c: place, w: dw, head: 2.1 })
        pe._changed()
        toast('已开门洞')
      })
    }
    void this
  }

  /** 把用户在图上点的两处距离换算成比例尺 */
  applyCalibration() {
    const pe = this.plan
    const c = pe.calib
    if (!c || !c.a || !c.b) {
      toast('先在图上点两处已知距离的两端（左侧「比例标定」按钮，或按 5）')
      return
    }
    const meters = clamp(Number($('#pe-calb').value) || 0, 0.1, 200)
    const px = Math.hypot(c.b.x - c.a.x, c.b.z - c.a.z)
    if (px < 8) {
      toast('两点太近了，重新点一下更远的两处')
      return
    }
    const oldPpm = pe.ppm
    const newPpm = px / meters
    pe.ppm = newPpm
    pe.calibrated = true

    // 已有的墙段按比例换算，免得描完之后标定会跑偏
    if (pe.walls.length && Math.abs(newPpm - oldPpm) > 1e-6) {
      const k = newPpm / oldPpm
      for (const w of pe.walls) {
        w.ax *= k
        w.az *= k
        w.bx *= k
        w.bz *= k
        w.t = (w.t || pe.wallThickness) * k
        for (const o of w.openings || []) {
          o.c *= k
          o.w *= k
        }
      }
      pe.wallThickness *= k
      pe.doorWidth *= k
    }

    pe.calib = null
    pe.setTool('wall')
    pe._changed()
    toast(`比例尺已设定：1 米 ≈ ${newPpm.toFixed(1)} 像素（图上 ${px.toFixed(0)}px = ${meters} 米）`)
  }

  closePlanEditor() {
    $('#plan-editor').hidden = true
    if (!this.current) this.showSheet('#start')
    else this.hideSheets()
  }

  buildFromPlanEditor() {
    const walls = this.plan.toWalls()
    if (!walls.length) {
      toast('先描几段墙')
      return
    }
    $('#plan-editor').hidden = true
    this.buildFromPlan(walls, {
      height: this.plan.wallHeight,
      thickness: this.plan.wallThickness / this.plan.ppm,
      name: this.plan.image ? '户型图 · ' + (this.plan.image.name || '自建') : '自建户型',
    })
  }

  /* ══════════════ 小地图 ══════════════ */

  bindMinimap() {
    // 画布尺寸跟随 CSS 盒子；点小地图把玩家挪过去
    this.minimap.resize()
    this.minimap.onPick = ({ x, z }) => {
      if (!this.ready) return
      const p = new THREE.Vector3(x, this.player.position.y, z)
      if (!this.collision.empty) {
        const g = this.collision.groundAt(x, z, p.y + 2, 400, 0.5)
        if (g !== null) p.y = g + 0.05
        this.collision.pushOut(p, this.player.radius, this.player.height)
      }
      this.player.placeAt(p, this.player.yaw)
      this.showHint('已移动到点击位置')
    }
  }

  /* ══════════════ 触屏 ══════════════ */

  bindJoystick() {
    if (!isTouch()) return
    $('#joystick').hidden = false
    $('#touch-actions').hidden = false
    $('.touch-only')?.classList.remove('hide')
    const joy = new Joystick($('#joystick'), $('#joy-base'), $('#joy-nub'), (x, y) => {
      this.player.joy.x = x
      this.player.joy.y = y
    })
    this.joystick = joy
    $$('#touch-actions [data-act]').forEach((b) =>
      b.addEventListener('pointerdown', () => {
        const a = b.dataset.act
        if (a === 'run') {
          this.player.running = !this.player.running
          b.classList.toggle('on', this.player.running)
        } else if (a === 'up') {
          this.player.keys.add('KeyE')
        } else if (a === 'down') {
          this.player.keys.add('KeyQ')
        }
      })
    )
    $$('#touch-actions [data-act]').forEach((b) => {
      const release = () => {
        const a = b.dataset.act
        if (a === 'up') this.player.keys.delete('KeyE')
        if (a === 'down') this.player.keys.delete('KeyQ')
        b.classList.remove('on')
      }
      b.addEventListener('pointerup', release)
      // 手指被系统手势/来电打断时不会收到 pointerup，按键会一直卡住，这里兜住
      b.addEventListener('pointercancel', release)
      b.addEventListener('pointerleave', release)
      b.addEventListener('lostpointercapture', release)
    })
  }

  /* ══════════════ 设置持久化 ══════════════ */

  loadSettings() {
    try {
      return JSON.parse(localStorage.getItem('house-tour-settings') || '{}')
    } catch {
      return {}
    }
  }

  saveSettings() {
    try {
      localStorage.setItem('house-tour-settings', JSON.stringify(this.settings))
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }

  applySettings() {
    const s = this.settings
    if (s.speed) {
      this.player.walkSpeed = s.speed
      $('#s-speed').value = s.speed
      $('#v-speed').textContent = Number(s.speed).toFixed(1)
    }
    if (s.fov) {
      this.camera.fov = s.fov
      this.camera.updateProjectionMatrix()
      $('#s-fov').value = s.fov
      $('#v-fov').textContent = s.fov
    }
    if (s.sens) {
      this.player.sensitivity = s.sens
      $('#s-sens').value = s.sens
      $('#v-sens').textContent = Number(s.sens).toFixed(1)
    }
    if (s.eye) {
      this.player.eyeHeight = s.eye
      $('#s-eye').value = s.eye
      $('#v-eye').textContent = Number(s.eye).toFixed(2)
    }
    for (const [k, id] of [
      ['#s-shadow', 'shadow'],
      ['#s-bob', 'bob'],
      ['#s-map', 'map'],
      ['#s-ceiling', 'ceiling'],
    ]) {
      if (s[id] !== undefined) $(k).checked = s[id]
    }
    this.player.bobEnabled = $('#s-bob').checked
    if (s.quality !== undefined && s.quality !== 0) {
      $('#s-q').value = String(s.quality)
      this.autoQuality = false
      this.setQuality(s.quality, { force: true })
    } else {
      this.setQuality(this.quality, { force: true })
    }
  }

  /* ══════════════ 深链接 ══════════════ */

  async handleDeepLink() {
    const p = new URLSearchParams(location.search)
    if (p.get('s') === '1') {
      this.loadSample()
      return
    }
    // 只允许加载本站 models/ 目录里的文件。不限制的话 ?m=//evil.com/x.glb 这种
    // 协议相对地址也能过正则，等于让链接随便指去外部地址加载内容。
    const m = p.get('m')
    if (m && /^models\/[\w.一-龥-]{1,120}$/.test(m) && !m.includes('..')) {
      await this.loadUrl(m)
      return
    } else if (m) {
      toast('分享链接里的模型地址不合法，只能是 models/ 下的文件')
    }
    const planStr = p.get('p')
    if (planStr) {
      try {
        const data = PlanEditor.deserialize(b64decode(planStr))
        this.plan.ppm = data.ppm
        this.plan.wallThickness = data.wallThickness
        this.plan.wallHeight = data.wallHeight
        this.plan.calibrated = true
        this.plan.walls = data.walls
        const walls = this.plan.toWalls()
        this.buildFromPlan(walls, { height: data.wallHeight, name: '分享的户型' })
        return
      } catch (err) {
        toast('分享链接里的户型数据解析失败：' + (err?.message || err))
      }
    }
    this.showSheet('#start')
  }
}

function extOf(name) {
  const i = String(name).lastIndexOf('.')
  return i < 0 ? '' : String(name).slice(i).toLowerCase()
}

// 启动
const app = new App()
window.__tour = app
app.init().catch((err) => {
  console.error(err)
  const note = $('#runtime-note')
  if (note) note.textContent = '启动失败：' + (err?.message || err)
  toast('启动失败：' + (err?.message || err), 8000)
})

// 方便排查
window.addEventListener('error', (e) => {
  console.error('[window error]', e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled]', e.reason)
})
