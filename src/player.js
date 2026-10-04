// 第一人称控制：键鼠 + 触屏摇杆，带重力、台阶吸附和贴墙滑动。
// 没有用 PointerLockControls —— 自己管 yaw/pitch 更好控制灵敏度和移动端手感。
import * as THREE from 'three'
import { clamp, damp, isTouch } from './util.js'

const PITCH_LIMIT = Math.PI / 2 - 0.02

export class Player {
  constructor(camera, collision, opts = {}) {
    this.camera = camera
    this.collision = collision

    this.position = new THREE.Vector3(0, 1.65, 0) // y 是脚底
    this.velocity = new THREE.Vector3()
    this.yaw = 0
    this.pitch = 0
    this.vy = 0

    this.radius = opts.radius ?? 0.32
    this.height = opts.height ?? 1.72
    this.eyeHeight = opts.eyeHeight ?? 1.65
    this.walkSpeed = opts.walkSpeed ?? 3.2
    this.runMultiplier = 2.0
    this.gravity = -19.0
    this.jumpSpeed = 4.4
    this.stepUp = 0.55
    this.accel = 13
    this.airAccel = 3.5
    this.sensitivity = 1.0

    this._coyote = 0
    this.noFloor = false
    this.fly = false
    this.grounded = false
    this.bobEnabled = true
    this.bobPhase = 0
    this.bobAmount = 0

    this.keys = new Set()
    this.look = { dx: 0, dy: 0 }
    this.joy = { x: 0, y: 0 }
    this.runHeld = false
    this.running = false
    this.enabled = false

    this.onGroundFail = null
    this.spawn = this.position.clone()
    this.spawnYaw = 0

    // 供小地图/调试读取
    this.speed = 0
    this.blocked = false

    this._euler = new THREE.Euler(0, 0, 0, 'YXZ')
    this._fwd = new THREE.Vector3()
    this._right = new THREE.Vector3()
    this._wish = new THREE.Vector3()
    this._tmp = new THREE.Vector3()

    this._bind()
  }

  /* ───────────── 输入 ───────────── */

  _bind() {
    this._onKeyDown = (e) => {
      if (e.repeat) {
        if (e.code === 'Space' || e.code === 'KeyQ' || e.code === 'KeyE') e.preventDefault()
        return
      }
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      this.keys.add(e.code)
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.runHeld = true
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
      if (this.onKey) this.onKey(e.code, e)
    }
    this._onKeyUp = (e) => {
      this.keys.delete(e.code)
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.runHeld = false
    }
    this._onBlur = () => {
      this.keys.clear()
      this.runHeld = false
    }
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)
    window.addEventListener('blur', this._onBlur)

    // 鼠标：点画布锁指针，移动时转向
    // 上一次交互是不是手指。触摸设备上点画布不该去锁指针。
    this._lastPointerWasTouch = false
    window.addEventListener('pointerdown', (e) => {
      this._lastPointerWasTouch = e.pointerType === 'touch'
    }, { capture: true })

    this._onMouseDownDrag = (e) => {
      // 没锁指针时保持按住拖动也能转头（旧代码读了 _dragging，但从来没人写它）
      if (e.button === 0 && !document.pointerLockElement) this._dragging = true
    }
    this._onMouseUpDrag = () => { this._dragging = false }
    window.addEventListener('mousedown', this._onMouseDownDrag)
    window.addEventListener('mouseup', this._onMouseUpDrag)
    window.addEventListener('blur', this._onMouseUpDrag)

    this._onMouseMove = (e) => {
      if (!this.enabled) return
      if (document.pointerLockElement) {
        this.look.dx += e.movementX || 0
        this.look.dy += e.movementY || 0
      } else if (this._dragging) {
        this.look.dx += e.movementX || 0
        this.look.dy += e.movementY || 0
      }
    }
    document.addEventListener('mousemove', this._onMouseMove)

    this._onPlChange = () => {
      if (this.onPointerLockChange) this.onPointerLockChange(!!document.pointerLockElement)
    }
    document.addEventListener('pointerlockchange', this._onPlChange)

    // 触屏：右半屏拖动转头
    this._touchLook = new Map()
    this._onTouchStart = (e) => {
      if (!this.enabled) return
      for (const t of e.changedTouches) {
        // 只在右半边、且不落在摇杆/按钮上时接管
        const el = e.target
        if (el && el.closest && el.closest('#joystick, button, input, .sheet')) continue
        if (t.clientX < window.innerWidth * 0.42 && isTouch()) continue
        this._touchLook.set(t.identifier, { x: t.clientX, y: t.clientY })
      }
    }
    this._onTouchMove = (e) => {
      if (!this.enabled) return
      for (const t of e.changedTouches) {
        const p = this._touchLook.get(t.identifier)
        if (!p) continue
        const k = 0.32 * this.sensitivity
        this.look.dx += (t.clientX - p.x) * k
        this.look.dy += (t.clientY - p.y) * k
        p.x = t.clientX
        p.y = t.clientY
      }
    }
    this._onTouchEnd = (e) => {
      for (const t of e.changedTouches) this._touchLook.delete(t.identifier)
    }
    document.addEventListener('touchstart', this._onTouchStart, { passive: true })
    document.addEventListener('touchmove', this._onTouchMove, { passive: true })
    document.addEventListener('touchend', this._onTouchEnd, { passive: true })
    document.addEventListener('touchcancel', this._onTouchEnd, { passive: true })
  }

  /** 由外部（画布）在点击时调用 */
  requestLock() {
    // 注意：不能因为 isTouch() 为真就拒绝锁指针。带触摸屏的笔记本 isTouch() 也是真，
    // 那样鼠标视角会完全失效。只有当这次交互确实来自手指时才不锁。
    if (this._lastPointerWasTouch) return
    const el = this.camera.userData.domElement || document.body
    try {
      el.requestPointerLock?.()
    } catch {
      /* 用户手势之外调用会失败，忽略 */
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock?.()
  }

  get locked() {
    return !!document.pointerLockElement
  }

  /* ───────────── 状态 ───────────── */

  placeAt(point, yaw = 0) {
    this.position.copy(point)
    this.vy = 0
    this.yaw = yaw
    this.pitch = 0
    this.spawn.copy(point)
    this.spawnYaw = yaw
  }

  respawn() {
    this.position.copy(this.spawn)
    this.vy = 0
    this.yaw = this.spawnYaw
    this.pitch = 0
  }

  get eyeY() {
    return this.position.y + this.eyeHeight
  }

  getPosition(out = new THREE.Vector3()) {
    return out.copy(this.position)
  }

  /* ───────────── 每帧 ───────────── */

  update(dt) {
    if (!this.enabled) return
    dt = Math.min(dt, 0.05)

    // 视角：先消耗累积的鼠标/触摸增量
    const sens = 0.0021 * this.sensitivity
    this.yaw -= this.look.dx * sens
    this.pitch -= this.look.dy * sens
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT)
    this.look.dx = 0
    this.look.dy = 0

    // 期望移动方向（相机水平朝向为基准）
    const k = this.keys
    let f = 0
    let s = 0
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1
    if (k.has('KeyD') || k.has('ArrowRight')) s += 1
    if (k.has('KeyA') || k.has('ArrowLeft')) s -= 1
    f += -this.joy.y
    s += this.joy.x
    const mag = Math.hypot(f, s)
    if (mag > 1) {
      f /= mag
      s /= mag
    }

    const running = this.runHeld || this.running
    const speed = this.walkSpeed * (running ? this.runMultiplier : 1)

    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    // 相机朝 -Z 看，所以前向是 (-sin, 0, -cos)
    const fx = -sin
    const fz = -cos
    const rx = cos
    const rz = -sin

    this._wish.set(fx * f + rx * s, 0, fz * f + rz * s)

    if (this.fly) {
      this._updateFly(dt, speed)
    } else {
      this._updateWalk(dt, speed)
    }

    // 行走时的轻微上下晃动，增强真实感
    const horiz = Math.hypot(this.velocity.x, this.velocity.z)
    if (this.bobEnabled && this.grounded && !this.fly) {
      this.bobPhase += dt * (4.2 + horiz * 1.1)
      const target = Math.min(horiz / 3.2, 1.4) * 0.045
      this.bobAmount = damp(this.bobAmount, target, 8, dt)
    } else {
      this.bobAmount = damp(this.bobAmount, 0, 8, dt)
    }
    const bob = Math.sin(this.bobPhase * 2) * this.bobAmount
    const sway = Math.cos(this.bobPhase) * this.bobAmount * 0.35

    this.speed = horiz

    // 写回相机
    this.camera.position.set(
      this.position.x + sway * Math.cos(this.yaw),
      this.eyeY + bob,
      this.position.z - sway * Math.sin(this.yaw)
    )
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ')
    this.camera.quaternion.setFromEuler(this._euler)
  }

  _updateWalk(dt, speed) {
    const col = this.collision

    // 水平速度向目标速度平滑靠拢，撞墙后能立刻停下而不是打滑
    const accel = this.grounded ? this.accel : this.airAccel
    const tvx = this._wish.x * speed
    const tvz = this._wish.z * speed
    this.velocity.x = damp(this.velocity.x, tvx, accel, dt)
    this.velocity.z = damp(this.velocity.z, tvz, accel, dt)

    const dx = this.velocity.x * dt
    const dz = this.velocity.z * dt
    if (col && !col.empty) {
      const before = { x: this.position.x, z: this.position.z }
      this.blocked = col.moveAndSlide(this.position, dx, dz, this.radius, this.height)
      // 被挡住就削掉对应方向的速度，避免持续贴墙累积
      const movedX = this.position.x - before.x
      const movedZ = this.position.z - before.z
      if (Math.abs(dx) > 1e-6 && Math.abs(movedX) < Math.abs(dx) * 0.5) this.velocity.x *= 0.2
      if (Math.abs(dz) > 1e-6 && Math.abs(movedZ) < Math.abs(dz) * 0.5) this.velocity.z *= 0.2
    } else {
      this.position.x += dx
      this.position.z += dz
      this.blocked = false
    }

    // 垂直：重力 + 台阶吸附
    const wantUp = this.keys.has('Space') || this.keys.has('KeyE')
    const wantDown = this.keys.has('KeyQ')

    let groundY = null
    if (col && !col.empty) {
      groundY = col.groundAt(this.position.x, this.position.z, this.position.y, 3.0, this.stepUp)
    }

    if (this.grounded && groundY === null && !this.noFloor) {
      // 走出边缘 → 开始下落
      this.grounded = false
    }

    // 头顶碰撞：上升时别穿过低矮的天花板
    if (this.vy > 0.001 && col && !col.empty && typeof col.ceilingAt === 'function') {
      const headY = this.position.y + this.height
      const ceil = col.ceilingAt(this.position.x, this.position.z, headY, 1.2)
      if (ceil !== null && ceil <= headY + 0.001) {
        this.position.y = Math.max(this.position.y, ceil - this.height - 0.01)
        this.vy = 0
      }
    }

    if (groundY !== null && this.vy <= 0.001) {
      // 站在地上（含上台阶：地面比脚底高一点也直接吸上去）
      const dy = groundY - this.position.y
      // 只有落差在一个台阶之内才吸附。旧代码写的是「dy 下降或者本来就站着就吸附」，
      // 于是 groundAt 一路查到 3 米以下的楼板，人走下高台会被瞬间按到地面（看着像瞬移）。
      if (dy <= this.stepUp + 0.02 && dy >= -(this.stepUp + 0.02)) {
        this.position.y = groundY
        this.vy = 0
        this.grounded = true
      } else {
        this.grounded = false
      }
    } else {
      this.grounded = false
    }

    if (!this.grounded) {
      this.vy += this.gravity * dt
      if (wantUp && this.grounded === false && this._coyote > 0) {
        this.vy = this.jumpSpeed
        this._coyote = 0
      }
      this.position.y += this.vy * dt
    } else {
      if (wantUp) {
        this.vy = this.jumpSpeed
        this.grounded = false
        this._coyote = 0
      } else {
        this.vy = 0
        this._coyote = 0
      }
      if (wantDown) this.position.y -= 1.6 * dt
    }

    if (this.grounded) this._coyote = 0.1
    else this._coyote = Math.max(0, (this._coyote || 0) - dt)

    // 掉出世界 → 拉回出生点
    const floor = col && !col.bounds.isEmpty() ? col.bounds.min.y : -1e9
    if (this.position.y < floor - 8) {
      if (this.onGroundFail) this.onGroundFail()
      this.respawn()
    }
  }

  _updateFly(dt, speed) {
    const col = this.collision
    // speed 在 _updateWalk 之前就已经乘过 runMultiplier 了，这里再乘一次会变成 4 倍速
    const spd = speed

    // 自由飞行：水平方向跟着视线走（抬头就往斜上方飞），Q/E 是纯垂直升降
    const up = (this.keys.has('Space') || this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0)

    this.velocity.x = damp(this.velocity.x, this._wish.x * spd, 10, dt)
    this.velocity.z = damp(this.velocity.z, this._wish.z * spd, 10, dt)
    this.velocity.y = damp(this.velocity.y, up * spd * 0.8, 10, dt)

    const dx = this.velocity.x * dt
    const dz = this.velocity.z * dt
    const dy = this.velocity.y * dt
    if (col && !col.empty) {
      col.moveAndSlide(this.position, dx, dz, this.radius, this.height)
      this.position.y += dy
    } else {
      this.position.x += dx
      this.position.z += dz
      this.position.y += dy
    }
    this.grounded = false
    this.blocked = false
  }

  setFly(on) {
    this.fly = !!on
    this.vy = 0
    if (!this.fly && this.collision && !this.collision.empty) {
      const g = this.collision.groundAt(this.position.x, this.position.z, this.position.y, 3, this.stepUp)
      if (g !== null) this.position.y = g
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown)
    window.removeEventListener('keyup', this._onKeyUp)
    window.removeEventListener('blur', this._onBlur)
    document.removeEventListener('mousemove', this._onMouseMove)
    document.removeEventListener('pointerlockchange', this._onPlChange)
    document.removeEventListener('touchstart', this._onTouchStart)
    document.removeEventListener('touchmove', this._onTouchMove)
    document.removeEventListener('touchend', this._onTouchEnd)
    document.removeEventListener('touchcancel', this._onTouchEnd)
  }
}

/**
 * 触屏摇杆：在左半屏按下时把底盘挪到手指位置
 */
export class Joystick {
  constructor(zone, base, nub, onChange) {
    this.zone = zone
    this.base = base
    this.nub = nub
    this.onChange = onChange
    this.active = null
    this.radius = 52
    this.maxRadius = 52

    zone.addEventListener('pointerdown', (e) => this._start(e), { passive: false })
    window.addEventListener('pointermove', (e) => this._move(e), { passive: false })
    window.addEventListener('pointerup', (e) => this._end(e))
    window.addEventListener('pointercancel', (e) => this._end(e))
  }

  _start(e) {
    if (this.active !== null) return
    e.preventDefault()
    this.active = e.pointerId
    this.origin = { x: e.clientX, y: e.clientY }
    const r = this.zone.getBoundingClientRect()
    this.radius = Math.min(r.width, r.height) * 0.26
    this.maxRadius = this.radius
    const size = this.radius * 2
    this.base.style.width = size + 'px'
    this.base.style.height = size + 'px'
    this.base.style.left = e.clientX - r.left - this.radius + 'px'
    this.base.style.top = e.clientY - r.top - this.radius + 'px'
    this.base.classList.add('live')
    this._setNub(0, 0)
    this.zone.setPointerCapture?.(e.pointerId)
  }

  _move(e) {
    if (e.pointerId !== this.active) return
    e.preventDefault()
    let dx = e.clientX - this.origin.x
    let dy = e.clientY - this.origin.y
    const len = Math.hypot(dx, dy)
    const max = this.maxRadius * 0.86
    if (len > max) {
      dx = (dx / len) * max
      dy = (dy / len) * max
    }
    this._setNub(dx, dy)
    const dead = 0.16
    let nx = dx / max
    let ny = dy / max
    const m = Math.hypot(nx, ny)
    if (m < dead) {
      nx = 0
      ny = 0
    } else {
      const k = ((m - dead) / (1 - dead)) / m
      nx *= k
      ny *= k
    }
    this.onChange(nx, ny)
  }

  _setNub(dx, dy) {
    this.nub.style.transform = `translate(${dx}px, ${dy}px)`
  }

  _end(e) {
    if (e.pointerId !== this.active) return
    this.active = null
    this.base.classList.remove('live')
    this._setNub(0, 0)
    this.onChange(0, 0)
  }
}
