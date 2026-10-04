// 把 node_modules 里的 three 拷到 vendor/ 下，让页面不依赖 CDN、离线也能跑。
// npm install 后会自动执行；也可手动: npm run vendor
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0
  fs.mkdirSync(dst, { recursive: true })
  let n = 0
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) n += copyDir(s, d)
    else if (e.isFile()) {
      fs.copyFileSync(s, d)
      n++
    }
  }
  return n
}

function copyFile(src, dst) {
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  return true
}

function findThreeBuildDir() {
  const base = path.join(ROOT, 'node_modules', 'three')
  if (!fs.existsSync(base)) return null
  return base
}

function main() {
  const threeSrc = findThreeBuildDir()
  if (!threeSrc) {
    console.error('\n[vendor] 没找到 node_modules/three。请先运行:  npm install\n')
    process.exitCode = 1
    return
  }

  const version = JSON.parse(fs.readFileSync(path.join(threeSrc, 'package.json'), 'utf8')).version
  const dst = path.join(ROOT, 'vendor', 'three')

  console.log(`[vendor] three@${version} → vendor/three`)
  rmrf(dst)
  fs.mkdirSync(dst, { recursive: true })

  // 1) 构建产物（新版 three 会把核心拆成 three.core.js，整目录拷过去最稳）
  const nBuild = copyDir(path.join(threeSrc, 'build'), path.join(dst, 'build'))

  // 2) addons（controls / loaders / utils / draco & basis 解码器都在这里）
  const nJsm = copyDir(
    path.join(threeSrc, 'examples', 'jsm'),
    path.join(dst, 'examples', 'jsm')
  )

  // 3) 校验入口文件确实存在，否则 importmap 会 404
  const entry = path.join(dst, 'build', 'three.module.js')
  if (!fs.existsSync(entry)) {
    const alts = fs.existsSync(path.join(dst, 'build'))
      ? fs.readdirSync(path.join(dst, 'build')).join(', ')
      : '(build 目录为空)'
    console.error(`[vendor] 警告: build/three.module.js 不存在。build 目录内容: ${alts}`)
    console.error('[vendor] 请把 index.html 里 importmap 的 "three" 指向上面列出的实际入口文件。')
    process.exitCode = 1
    return
  }

  // 4) BVH 加速库（碰撞和户型图扫描靠它，缺了会退化但仍可用）
  const bvhSrc = path.join(ROOT, 'node_modules', 'three-mesh-bvh')
  if (fs.existsSync(bvhSrc)) {
    const bvhDst = path.join(ROOT, 'vendor', 'three-mesh-bvh')
    rmrf(bvhDst)
    fs.mkdirSync(bvhDst, { recursive: true })
    copyFile(path.join(bvhSrc, 'package.json'), path.join(bvhDst, 'package.json'))
    copyFile(path.join(bvhSrc, 'build', 'index.module.js'), path.join(bvhDst, 'index.module.js'))
    copyDir(path.join(bvhSrc, 'src'), path.join(bvhDst, 'src'))
    const ok = fs.existsSync(path.join(bvhDst, 'index.module.js'))
    console.log(`[vendor] three-mesh-bvh ${ok ? 'ok' : '缺失（碰撞会退化，可接受）'}`)
  } else {
    console.log('[vendor] 未安装 three-mesh-bvh（可选，装了性能更好）')
  }

  console.log(`[vendor] 完成: build ${nBuild} 个文件, addons ${nJsm} 个文件`)
}

main()
