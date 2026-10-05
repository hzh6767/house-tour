// 端到端测试：用 Chrome DevTools 协议驱动真实浏览器，验证载入、行走、碰撞、小地图。
// 用法:  node scripts/e2e.mjs            （需要 npm start 已在 5173 端口运行）
//        node scripts/e2e.mjs --keep     （结束后不关 Chrome，方便看）
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import http from 'node:http'

const BASE = process.env.BASE || 'http://localhost:5173'
const PORT = 9333
const KEEP = process.argv.includes('--keep')
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const chromePath = process.env.CHROME || CANDIDATES.find((p) => fs.existsSync(p))
if (!chromePath) {
  console.error('找不到 Chrome/Edge，请设置 CHROME 环境变量')
  process.exit(2)
}

const getJSON = (url) =>
  new Promise((res, rej) => {
    http.get(url, (r) => {
      let s = ''
      r.on('data', (c) => (s += c))
      r.on('end', () => {
        try {
          res(JSON.parse(s))
        } catch (e) {
          rej(e)
        }
      })
    }).on('error', rej)
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 本脚本需要 5173 端口已在提供服务。以前它只假设 `npm start` 已经跑起来了，
// 于是干净检出下 `npm test` 必然卡在「样板间就绪」超时。这里改成：没有现成的
// 服务器就自己起一个（复用 serve.js），退出时再收掉，保证 npm test 自给自足。
let ownedServer = null

function serverAlive() {
  return new Promise((res) => {
    const u = new URL(BASE)
    const req = http.get(
      { host: u.hostname, port: u.port || 80, path: '/', timeout: 2000 },
      (r) => { r.resume(); res(true) }
    )
    req.on('error', () => res(false))
    req.on('timeout', () => { req.destroy(); res(false) })
  })
}

async function ensureServer() {
  if (await serverAlive()) return
  const servePath = fileURLToPath(new URL('../serve.js', import.meta.url))
  ownedServer = spawn(process.execPath, [servePath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, PORT: String(new URL(BASE).port || 5173) },
  })
  for (let i = 0; i < 80; i++) {
    if (await serverAlive()) return
    await sleep(250)
  }
  throw new Error(`dev server 未能在 ${BASE} 提供服务`)
}

function stopServer() {
  if (!ownedServer) return
  try { ownedServer.kill() } catch {}
  ownedServer = null
}

let fails = 0
let passes = 0
function check(name, cond, extra = '') {
  const ok = !!cond
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   ' + extra : ''}`)
  if (ok) passes++
  else fails++
}

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1100,700',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + fs.mkdtempSync(process.env.TEMP + '/ht-e2e-'),
    'about:blank',
  ],
  { stdio: 'ignore' }
)

let ws
let msgId = 0
const pending = new Map()
const errors = []
const consoleErrors = []
let sessionId = null

function send(method, params = {}, sid = sessionId) {
  const id = ++msgId
  const msg = { id, method, params }
  if (sid) msg.sessionId = sid
  ws.send(JSON.stringify(msg))
  return new Promise((res, rej) => pending.set(id, { res, rej, method }))
}

async function evaluate(expr, { awaitPromise = true } = {}) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error('页面异常: ' + (d.exception?.description || d.text || JSON.stringify(d)))
  }
  return r.result?.value
}

async function waitFor(expr, timeoutMs = 60000, label = expr) {
  const t0 = Date.now()
  for (;;) {
    let v
    try {
      v = await evaluate(expr)
    } catch (e) {
      v = undefined
    }
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时: ' + label)
    await sleep(200)
  }
}

async function main() {
  // 先确保服务器在跑，否则后续 Page.navigate 拿不到页面
  await ensureServer()
  // 等调试端口起来
  let version
  for (let i = 0; i < 60; i++) {
    try {
      version = await getJSON(`http://127.0.0.1:${PORT}/json/version`)
      break
    } catch {
      await sleep(250)
    }
  }
  if (!version) throw new Error('Chrome 调试端口没有起来')

  ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`))
      else p.res(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errors.push(d.exception?.description || d.text)
    }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      // three 的材质编译 warning 之类也记下来，最后统一看
      consoleErrors.push(`[${m.params.type}] ${text}`)
    }
  }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null)
  const att = await send('Target.attachToTarget', { targetId, flatten: true }, null)
  sessionId = att.sessionId
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false })

  /* ───────────── 1. 样板间 ───────────── */
  console.log('\n── 1. 样板间 (?s=1)')
  await send('Page.navigate', { url: `${BASE}/?s=1` })
  await waitFor('window.__tour && window.__tour.ready === true', 90000, '样板间就绪')
  const s1 = await evaluate(`(() => {
    const t = window.__tour
    const p = t.player.position
    return {
      name: document.getElementById('place-name').textContent,
      startHidden: document.getElementById('start').hidden,
      loadingHidden: document.getElementById('loading').hidden,
      minimapVisible: !document.getElementById('minimap-wrap').hidden,
      toolbarVisible: !document.getElementById('toolbar').hidden,
      meshes: t.collision.meshes.length,
      tris: t.collision.triangles,
      pos: [p.x, p.y, p.z],
      grounded: t.player.grounded,
      bvh: t.collision.meshes.filter(m => m.geometry.boundsTree).length,
      sceneChildren: t.sceneRoot.children.length,
      isTouch: document.getElementById('joystick').hidden === false,
    }
  })()`)
  check('场景名是样板间', s1.name.includes('样板间'), s1.name)
  check('启动页已隐藏，加载层已隐藏', s1.startHidden && s1.loadingHidden)
  check('工具条与小地图可见', s1.toolbarVisible && s1.minimapVisible)
  check('碰撞网格已收集', s1.meshes > 50, `meshes=${s1.meshes} tris=${s1.tris}`)
  check('BVH 已构建', s1.bvh === s1.meshes, `${s1.bvh}/${s1.meshes}`)
  check('出生点在客厅里 (5.4, 6.4)', Math.abs(s1.pos[0] - 5.4) < 0.5 && Math.abs(s1.pos[2] - 6.4) < 0.5, s1.pos.map((v) => v.toFixed(2)).join(', '))
  check('出生点脚底在地板上 (y≈0)', Math.abs(s1.pos[1]) < 0.08, `y=${s1.pos[1].toFixed(3)}`)
  check('桌面环境没有弹出摇杆', s1.isTouch === false)

  // 行走：面朝 -Z（yaw=0）走 2 秒，应当向北移动且不穿墙
  const walk = await evaluate(`(() => {
    const t = window.__tour, p = t.player
    p.enabled = true
    p.yaw = 0; p.pitch = 0
    p.position.set(5.4, 0, 6.4); p.velocity.set(0,0,0)
    const start = p.position.clone()
    p.keys.add('KeyW')
    for (let i = 0; i < 120; i++) p.update(1/60)   // 2 秒
    p.keys.delete('KeyW')
    const afterFree = p.position.clone()
    // 继续往北走 6 秒，会撞到 z=3.6 的横向内墙（客厅/卧室之间），门洞不在 x=5.4 处
    p.keys.add('KeyW')
    let blockedSeen = false
    for (let i = 0; i < 360; i++) { p.update(1/60); if (p.blocked) blockedSeen = true }
    p.keys.delete('KeyW')
    const afterWall = p.position.clone()
    return { start: [start.x, start.z], afterFree: [afterFree.x, afterFree.z], afterWall: [afterWall.x, afterWall.y, afterWall.z], blockedSeen, grounded: p.grounded }
  })()`)
  const dz = walk.start[1] - walk.afterFree[1]
  // 起点 z=6.4 朝北走，客厅/卧室之间的内墙在 z=3.6，玩家半径使其停在 z≈3.975，
  // 因此 2 秒内的可行进距离上限约 2.43 米 —— 原来的 3.5..6.6 假设前方是空地，
  // 在这张样板间地图里根本不可能达到。这里改为断言「撞到内墙前走完了这段距离」。
  check('按 W 向北移动到内墙前 (2s，上限约 2.43m)', dz > 2.2 && dz < 2.6, `Δz=${dz.toFixed(2)}`)
  check('x 基本不变', Math.abs(walk.afterFree[0] - walk.start[0]) < 0.05)
  check('撞到内墙被挡住', walk.blockedSeen === true)
  check('没有穿过 z=3.6 的墙 (停在墙南侧)', walk.afterWall[2] > 3.6 + 0.05 && walk.afterWall[2] < 4.4, `z=${walk.afterWall[2].toFixed(3)}`)
  check('撞墙后仍然站在地上', Math.abs(walk.afterWall[1]) < 0.08 && walk.grounded, `y=${walk.afterWall[1].toFixed(3)}`)

  // 穿门洞：主卧门在 x=1.9；从 (1.9, 4.5) 朝北走应能进入主卧 (z<3.6)
  const door = await evaluate(`(() => {
    const t = window.__tour, p = t.player
    p.yaw = 0; p.position.set(1.9, 0, 4.6); p.velocity.set(0,0,0)
    p.keys.add('KeyW')
    for (let i = 0; i < 240; i++) p.update(1/60)
    p.keys.delete('KeyW')
    return [p.position.x, p.position.y, p.position.z]
  })()`)
  check('能从门洞走进主卧 (z < 3.4)', door[2] < 3.4, `pos=(${door.map((v) => v.toFixed(2)).join(', ')})`)

  // 家具碰撞：客厅沙发在 (3.4, 4.75) 宽 2.3；从 (3.4, 6.0) 往北走应被沙发挡住
  const sofa = await evaluate(`(() => {
    const t = window.__tour, p = t.player
    p.yaw = 0; p.position.set(3.4, 0, 6.6); p.velocity.set(0,0,0)
    p.keys.add('KeyW')
    for (let i = 0; i < 240; i++) p.update(1/60)
    p.keys.delete('KeyW')
    return [p.position.x, p.position.z]
  })()`)
  check('被沙发挡住 (z 停在 5.2 以南)', sofa[1] > 5.15, `z=${sofa[1].toFixed(2)}`)

  // 小地图绘制一帧不报错
  const mm = await evaluate(`(() => {
    const t = window.__tour
    t.minimap.draw(t.player.position, t.player.yaw, { fov: 72 })
    const c = document.getElementById('minimap')
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let lit = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++
    return { w: c.width, h: c.height, lit, total: d.length / 4, plan: !!t.minimap.plan, walls: t.minimap.plan?.walls?.length }
  })()`)
  check('小地图有内容', mm.plan && mm.lit > mm.total * 0.3, `${mm.w}x${mm.h} lit=${mm.lit} walls=${mm.walls}`)

  // 渲染几帧，看 WebGL 有没有报错
  await evaluate(`new Promise(r => { let n = 0; const f = () => { window.__tour.frame(); if (++n < 5) requestAnimationFrame(f); else r(true) }; f() })`)
  const glErr = await evaluate(`window.__tour.renderer.getContext().getError()`)
  check('WebGL 无错误', glErr === 0, `getError=${glErr}`)

  /* ───────────── 2. 导入 GLB（毫米单位） ───────────── */
  console.log('\n── 2. 导入 GLB（test-room.glb，毫米）')
  await evaluate(`window.__tour.loadUrl('models/test-room.glb')`, { awaitPromise: false })
  await waitFor(`window.__tour.ready && window.__tour.current && window.__tour.current.kind === 'model'`, 60000, 'GLB 就绪')
  // 等后台真正烘完小地图，而不是死等 1.5 秒。烘焙走 setTimeout(400) + requestIdleCallback，
  // 慢机器上 1.5 秒可能不够，之前这一项就是这样偶发失败的。改为轮询真实完成信号：
  // planFromGrid 返回 { wallGrid, bounds }，所以 plan.wallGrid 出现即为完成。
  await waitFor(`window.__tour.minimap && window.__tour.minimap.plan && window.__tour.minimap.plan.wallGrid`, 30000, '导入模型的小地图烘焙')
  const g = await evaluate(`(() => {
    const t = window.__tour, c = t.current, p = t.player
    // 量模型自己，不要量 t.collision.bounds —— 后者是「模型 + 半径 220 的外景地面」
    // 的并集，x/z 会被那个 440 直径的圆盘撑满（这就是曾经量出 440×2.83×440 的原因）。
    // loaded.bounds 由 loader 在居中落地后重算，min.y ≈ 0；loaded.size 是模型三轴尺寸。
    const b = c.loaded.bounds
    return {
      name: document.getElementById('place-name').textContent,
      autoScale: c.loaded.autoScale,
      size: [c.loaded.size.x, c.loaded.size.y, c.loaded.size.z],
      minY: b.min.y,
      pos: [p.position.x, p.position.y, p.position.z],
      grounded: p.grounded,
      meshes: t.collision.meshes.length,
      minimap: !document.getElementById('minimap-wrap').hidden,
      footprint: !!(t.minimap.plan && t.minimap.plan.wallGrid),
      tris: c.loaded.stats.triangles,
    }
  })()`)
  check('识别出毫米单位并缩放 0.001', Math.abs(g.autoScale - 0.001) < 1e-9, `autoScale=${g.autoScale}`)
  check('缩放后尺寸约 6×2.8×4 m', Math.abs(g.size[0] - 6) < 0.05 && Math.abs(g.size[2] - 4) < 0.05 && g.size[1] > 2.6 && g.size[1] < 2.9, g.size.map((v) => v.toFixed(2)).join('×'))
  check('模型落地 (min y ≈ 0)', Math.abs(g.minY) < 0.01, `minY=${g.minY.toFixed(4)}`)
  check('玩家站在地板上', g.pos[1] > 0.05 && g.pos[1] < 0.2, `y=${g.pos[1].toFixed(3)} (地板顶面在 0.1)`)
  check('玩家在房间内部', Math.abs(g.pos[0]) < 3 && Math.abs(g.pos[2]) < 2, `(${g.pos[0].toFixed(2)}, ${g.pos[2].toFixed(2)})`)
  check('导入模型自动烘出小地图', g.minimap && g.footprint)

  // 走向东墙门洞：门洞在原始 z=2000mm → 居中后 z=0，x=+3 处
  const g2 = await evaluate(`(() => {
    const t = window.__tour, p = t.player
    // 面朝 +X：相机朝向 (-sin yaw, -cos yaw) = (1, 0) → yaw = -PI/2
    // 起点不能取 (0,0)：那正是模型里那张 0.8×0.8 桌子的中心（make-test-assets.mjs
    // 的 box(2600,0,1600,3400,750,2400) 居中后占 x∈[-0.4,0.4]），玩家半径 0.32，
    // 会立刻停在 x = 0.4-0.32 = 0.08 —— 之前那次「走不出门洞」的假失败就是这个。
    // 改从 x=1.0 出发，已越过桌子东面(0.4)+半径(0.32)，正对空门洞。
    p.yaw = -Math.PI/2; p.position.set(1.0, p.position.y, 0); p.velocity.set(0,0,0)
    p.keys.add('KeyW')
    for (let i = 0; i < 300; i++) p.update(1/60)
    p.keys.delete('KeyW')
    const out = [p.position.x, p.position.z]
    // 再试撞墙：从 (0, -1.2) 朝 +X 走，门洞外应被挡
    p.position.set(0, p.position.y, -1.2); p.velocity.set(0,0,0)
    p.keys.add('KeyW'); let blocked=false
    for (let i = 0; i < 300; i++) { p.update(1/60); if (p.blocked) blocked = true }
    p.keys.delete('KeyW')
    return { throughDoor: out, wall: [p.position.x, p.position.z], blocked }
  })()`)
  check('能穿过导入模型的门洞走出去 (x > 3.1)', g2.throughDoor[0] > 3.1, `x=${g2.throughDoor[0].toFixed(2)}`)
  check('门洞之外的墙挡得住 (x < 2.95)', g2.blocked && g2.wall[0] < 2.95, `x=${g2.wall[0].toFixed(2)}`)

  // 桌子碰撞：桌子在原始 x 2600–3400, z 1600–2400 → 居中后 x -0.4..0.4, z -0.4..0.4，高 0.75
  const tbl = await evaluate(`(() => {
    const t = window.__tour, p = t.player
    p.yaw = 0; p.position.set(0, p.position.y, 1.6); p.velocity.set(0,0,0)
    p.keys.add('KeyW')
    for (let i = 0; i < 200; i++) p.update(1/60)
    p.keys.delete('KeyW')
    return [p.position.x, p.position.y, p.position.z]
  })()`)
  check('0.75m 高的桌子挡住玩家（不会被当成台阶）', tbl[2] > 0.6, `z=${tbl[2].toFixed(2)} y=${tbl[1].toFixed(2)}`)

  /* ───────────── 3. 导入 ZIP ───────────── */
  console.log('\n── 3. 导入 ZIP（test-room.zip，含中文目录）')
  await evaluate(`window.__tour.loadUrl('models/test-room.zip')`, { awaitPromise: false })
  await waitFor(`window.__tour.ready && window.__tour.current && window.__tour.current.loaded && window.__tour.current.loaded.archiveName`, 60000, 'ZIP 就绪')
  const z = await evaluate(`(() => { const c = window.__tour.current.loaded; return { entry: c.entry, contained: c.contained, autoScale: c.autoScale, tris: c.stats.triangles } })()`)
  check('从 zip 里挑到了 glb 入口', z.entry === '户型/test-room.glb', z.entry)
  check('zip 内文件数正确', z.contained === 2)
  check('zip 路径同样完成单位归一', Math.abs(z.autoScale - 0.001) < 1e-9)

  /* ───────────── 4. 本地文件路径（File 对象） ───────────── */
  console.log('\n── 4. 拖入本地文件（FileReader 路径）')
  await evaluate(`(async () => {
    const buf = await (await fetch('models/test-room.glb')).arrayBuffer()
    const f = new File([buf], '我的房子.glb')
    window.__tour._lastFile = f
    window.__tour.loadFiles([f])
    return true
  })()`)
  await waitFor(`window.__tour.ready && document.getElementById('place-name').textContent === '我的房子'`, 60000, '本地文件就绪')
  check('本地文件载入并以文件名命名', true)

  /* ───────────── 5. 户型图生成 ───────────── */
  console.log('\n── 5. 户型图 → 3D')
  await evaluate(`(() => {
    const walls = [
      { ax: 0, az: 0, bx: 5, bz: 0, t: 0.12, openings: [{ type: 'window', c: 2.5, w: 1.4, sill: 0.9, head: 2.3 }] },
      { ax: 5, az: 0, bx: 5, bz: 4, t: 0.12, openings: [] },
      { ax: 5, az: 4, bx: 0, bz: 4, t: 0.12, openings: [{ type: 'door', c: 2.5, w: 0.9 }] },
      { ax: 0, az: 4, bx: 0, bz: 0, t: 0.12, openings: [] },
    ]
    window.__tour.buildFromPlan(walls, { height: 2.7, name: '测试户型' })
    return true
  })()`)
  await waitFor(`window.__tour.ready && window.__tour.current && window.__tour.current.kind === 'plan'`, 60000, '户型就绪')
  const pl = await evaluate(`(() => {
    const t = window.__tour, p = t.player
    let floors = 0, ceilings = 0, glass = 0
    t.sceneRoot.traverse(o => { if (o.userData.isCeiling) ceilings++; if (o.material && o.material.transparent) glass++ })
    return { pos: [p.position.x, p.position.y, p.position.z], grounded: p.grounded, meshes: t.collision.meshes.length, ceilings, glass, name: document.getElementById('place-name').textContent, minimap: !document.getElementById('minimap-wrap').hidden }
  })()`)
  check('户型已生成并命名', pl.name === '测试户型', pl.name)
  check('出生点在房间内', pl.pos[0] > 0.3 && pl.pos[0] < 4.7 && pl.pos[2] > 0.3 && pl.pos[2] < 3.7, pl.pos.map((v) => v.toFixed(2)).join(', '))
  check('站在地板上', Math.abs(pl.pos[1]) < 0.08, `y=${pl.pos[1].toFixed(3)}`)
  check('生成了天花板和窗玻璃', pl.ceilings >= 1 && pl.glass >= 1, `ceilings=${pl.ceilings} glass=${pl.glass}`)
  check('小地图可见', pl.minimap)
  const plDoor = await evaluate(`(() => {
    const p = window.__tour.player
    // 门在南墙 (z=4) x=2.5；面朝 +Z → yaw = PI
    p.yaw = Math.PI; p.position.set(2.5, 0, 2.5); p.velocity.set(0,0,0)
    p.keys.add('KeyW'); for (let i = 0; i < 240; i++) p.update(1/60); p.keys.delete('KeyW')
    const a = [p.position.x, p.position.z]
    // 窗不能穿：北墙 z=0 x=2.5，面朝 -Z
    p.yaw = 0; p.position.set(2.5, 0, 1.5); p.velocity.set(0,0,0)
    p.keys.add('KeyW'); for (let i = 0; i < 240; i++) p.update(1/60); p.keys.delete('KeyW')
    return { door: a, win: [p.position.x, p.position.z] }
  })()`)
  check('能从门洞走出去 (z > 4.1)', plDoor.door[1] > 4.1, `z=${plDoor.door[1].toFixed(2)}`)
  check('窗户挡住（窗台墙）(z > 0.3)', plDoor.win[1] > 0.3, `z=${plDoor.win[1].toFixed(2)}`)

  /* ───────────── 6. 分享链接 round-trip ───────────── */
  console.log('\n── 6. 户型分享链接')
  const share = await evaluate(`(() => {
    const t = window.__tour
    t.plan.walls = [{ ax: 0, az: 0, bx: 280, bz: 0, t: 7, openings: [{ type: 'door', c: 140, w: 50 }] }, { ax: 280, az: 0, bx: 280, bz: 224, t: 7, openings: [] }]
    t.plan.ppm = 56
    return t.plan.toShareString()
  })()`)
  check('生成了分享串', typeof share === 'string' && share.length > 20, `len=${share.length}`)
  await send('Page.navigate', { url: `${BASE}/?p=${share}` })
  await waitFor(`window.__tour && window.__tour.ready && window.__tour.current && window.__tour.current.kind === 'plan'`, 60000, '分享链接载入')
  const shared = await evaluate(`(() => { const w = window.__tour.current.walls; return { n: w.length, len: Math.hypot(w[0].bx - w[0].ax, w[0].bz - w[0].az), door: w[0].openings[0].w } })()`)
  check('分享链接还原了墙段 (280px/56 = 5m)', shared.n === 2 && Math.abs(shared.len - 5) < 0.01 && Math.abs(shared.door - 50 / 56) < 0.01, JSON.stringify(shared))

  /* ───────────── 7. 服务器接口 ───────────── */
  console.log('\n── 7. 服务器接口')
  const list = await evaluate(`fetch('/_models').then(r => r.json())`)
  check('/_models 列出了测试模型', list.models.some((m) => m.name === 'test-room.glb'), list.models.map((m) => m.name).join(', '))
  const up = await evaluate(`(async () => {
    const r = await fetch('/_upload?name=' + encodeURIComponent('../evil.glb'), { method: 'POST', body: new Blob([new Uint8Array(8)]) })
    const r2 = await fetch('/_upload?name=' + encodeURIComponent('e2e-upload.glb'), { method: 'POST', body: await (await fetch('models/test-room.glb')).blob() })
    const j = await r2.json()
    const r3 = await fetch('/_upload?name=notes.exe', { method: 'POST', body: new Blob([new Uint8Array(8)]) })
    return { traversal: r.status, ok: r2.status, url: j.url, badExt: r3.status }
  })()`)
  check('上传拒绝路径穿越', up.traversal === 400, `status=${up.traversal}`)
  check('上传拒绝不支持的扩展名', up.badExt === 400, `status=${up.badExt}`)
  check('正常上传成功', up.ok === 200 && up.url === 'models/e2e-upload.glb', `status=${up.ok} url=${up.url}`)
  const range = await evaluate(`fetch('models/test-room.glb', { headers: { Range: 'bytes=0-99' } }).then(r => ({ status: r.status, len: r.headers.get('content-length'), cr: r.headers.get('content-range') }))`)
  check('Range 请求返回 206', range.status === 206 && range.len === '100', JSON.stringify(range))

  /* ───────────── 汇总 ───────────── */
  const realErrors = errors.filter((e) => !/ResizeObserver|GPU stall/.test(e))
  const realConsole = consoleErrors.filter((e) => !/GPU stall|THREE\.WebGLRenderer: Context Lost|Fontconfig/.test(e))
  check('页面没有未捕获异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
  check('console 没有 error 级输出', realConsole.filter((e) => e.startsWith('[error]')).length === 0, realConsole.filter((e) => e.startsWith('[error]')).slice(0, 3).join(' | '))
  if (realConsole.length) {
    console.log('\nconsole 输出（含 warning）:')
    for (const c of realConsole.slice(0, 12)) console.log('   ' + c.slice(0, 220))
  }

  console.log(`\n${passes} passed, ${fails} failed`)
}

main()
  .catch((e) => {
    console.error('\nE2E 中断:', e.message)
    if (errors.length) console.error('页面异常:', errors.slice(0, 5))
    fails++
  })
  .finally(() => {
    try {
      fs.rmSync('models/e2e-upload.glb', { force: true })
    } catch {}
    stopServer()
    if (!KEEP) chrome.kill()
    process.exit(fails ? 1 : 0)
  })
