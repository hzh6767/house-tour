// 极简静态服务器 + 模型上传接口。
// 用法: npm start   然后打开 http://localhost:5173/
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const MODELS_DIR = path.join(ROOT, 'models')
const FAVICON = path.join(ROOT, 'assets', 'favicon.png')
const PORT = Number(process.env.PORT) || 5173
const HOST = process.env.HOST || '0.0.0.0'
const MAX_UPLOAD = 800 * 1024 * 1024 // 800MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.fbx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.stl': 'model/stl',
  '.ply': 'application/octet-stream',
  '.dae': 'model/vnd.collada+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/aces',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const SAFE_NAME = /^[A-Za-z0-9._一-龥-]{1,120}$/
const ALLOWED_EXT = new Set([
  '.glb', '.gltf', '.obj', '.mtl', '.fbx', '.stl', '.ply', '.dae', '.bin',
  '.png', '.jpg', '.jpeg', '.webp', '.ktx2', '.hdr', '.exr',
  '.zip', '.3mf',
])

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type })
  res.end(body)
}

// 内置图标：浏览器每次开页面都会自动请求 /favicon.ico，这里直接给它一个 PNG，
// 免得控制台一直刷 404。图标文件在 assets/favicon.png，不依赖外网。
function serveFavicon(req, res) {
  fs.stat(FAVICON, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, '404  /favicon.ico')
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(FAVICON).pipe(res)
  })
}

async function handleUpload(req, res, url) {
  let name = ''
  try {
    name = decodeURIComponent(url.searchParams.get('name') || '')
  } catch {
    return send(res, 400, 'bad name')
  }
  // 带路径分隔符或空字节的名字直接拒绝，不做「好心」的 basename 归一：明确比宽容更安全
  if (/[\\/\0]/.test(name)) return send(res, 400, '文件名不能包含路径分隔符')
  name = path.basename(name)
  const ext = path.extname(name).toLowerCase()
  if (!SAFE_NAME.test(name) || !ALLOWED_EXT.has(ext)) {
    return send(res, 400, '文件名不合法（只允许字母数字点横线中文，且需为受支持的模型/贴图格式）')
  }
  await fsp.mkdir(MODELS_DIR, { recursive: true })
  const dest = path.join(MODELS_DIR, name)

  const declared = Number(req.headers['content-length'] || 0)
  if (declared > MAX_UPLOAD) return send(res, 413, '文件过大')

  let written = 0
  let aborted = false
  const out = fs.createWriteStream(dest)
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (c) => {
        written += c.length
        if (written > MAX_UPLOAD) {
          aborted = true
          reject(new Error('too large'))
          req.destroy()
        }
      })
      req.pipe(out)
      out.on('finish', resolve)
      out.on('error', reject)
      req.on('error', reject)
    })
  } catch {
    if (!aborted) {
      try { await fsp.unlink(dest) } catch {}
      return send(res, 500, '写入失败')
    }
    try { await fsp.unlink(dest) } catch {}
    return send(res, 413, '文件过大')
  }

  console.log(`  ↑ 已保存 models/${name}  (${(written / 1048576).toFixed(1)} MB)`)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, name, url: `models/${name}`, size: written }))
}

async function handleList(res) {
  await fsp.mkdir(MODELS_DIR, { recursive: true })
  const names = await fsp.readdir(MODELS_DIR)
  const out = []
  for (const n of names) {
    if (n.startsWith('.')) continue
    const ext = path.extname(n).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) continue
    try {
      const st = await fsp.stat(path.join(MODELS_DIR, n))
      if (st.isFile()) out.push({ name: n, size: st.size, url: `models/${n}` })
    } catch {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ models: out }))
}

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    return send(res, 400, '400 bad request')
  }
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return send(res, 400, '400 bad request')
  }

  if (pathname === '/_upload' && req.method === 'POST') return handleUpload(req, res, url)
  if (pathname === '/_models' && req.method === 'GET') return handleList(res)
  if (pathname === '/favicon.ico' || pathname === '/favicon.png') return serveFavicon(req, res)

  let rel = pathname === '/' || pathname.endsWith('/') ? pathname + 'index.html' : pathname
  rel = path.normalize(rel).split(path.sep).filter(Boolean).join(path.sep)
  const file = path.resolve(ROOT, rel)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, '403 forbidden')

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, `404  ${pathname}`)
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' }
    // 支持 Range，大模型断点/分段加载更稳
    const range = req.headers.range
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.replace('bytes=', '').split('-')
      const start = s ? Number(s) : 0
      const end = e ? Number(e) : st.size - 1
      if (start <= end && end < st.size) {
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
        headers['Accept-Ranges'] = 'bytes'
        headers['Content-Length'] = end - start + 1
        res.writeHead(206, headers)
        if (req.method === 'HEAD') return res.end()
        return fs.createReadStream(file, { start, end }).pipe(res)
      }
    }
    headers['Content-Length'] = st.size
    headers['Accept-Ranges'] = 'bytes'
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).pipe(res)
  })
})

function localIPs() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

server.listen(PORT, HOST, () => {
  const ips = localIPs()
  console.log('')
  console.log('  3D 看房 —— 服务已启动')
  console.log('  ──────────────────────────────────────')
  console.log(`  本机打开    http://localhost:${PORT}/`)
  for (const ip of ips) console.log(`  手机打开    http://${ip}:${PORT}/   ← 同一 WiFi`)
  if (!ips.length) console.log('  手机打开    (未检测到局域网 IP，请检查网络)')
  console.log('')
  console.log(`  模型目录    ${MODELS_DIR}`)
  console.log('  Ctrl+C 停止')
  console.log('')
})
