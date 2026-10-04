// 极简 ZIP 读取器。
// 用途：设计师给的模型经常打包成 .zip（obj + mtl + 一堆贴图），
// 在浏览器里解压后放进虚拟文件系统，各个 loader 才能找到贴图。
// 只依赖浏览器自带的 DecompressionStream，不需要第三方库。

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const UTF8_FLAG = 0x800

function decodeName(bytes) {
  // 先按 UTF-8 解；中文压缩软件常写 GBK，解码出替换字符就换编码再试
  let name = new TextDecoder('utf-8').decode(bytes)
  if (name.includes('�')) {
    try {
      name = new TextDecoder('gbk').decode(bytes)
    } catch {
      /* 浏览器不支持 gbk 就用 utf-8 的结果 */
    }
  }
  return name
}

// 解压上限 —— 防「压缩炸弹」：几十 KB 的包解出几个 GB 把浏览器撑爆
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024 // 单个文件解压后 1GB
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024 // 整包解压后 2GB
const MAX_ENTRIES = 20000

// 流式解压并计数，超过上限立刻中止，而不是等全部解完再发现太大
async function inflateRaw(bytes, limit = MAX_ENTRY_BYTES) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new Error(`解压后超过 ${Math.round(limit / 1048576)} MB 上限`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.byteLength
  }
  return out
}

/**
 * @param {File|Blob} file
 * @returns {Promise<Map<string, {blob: Blob, size: number}>>} 路径 → 文件
 */
export async function unzip(file) {
  const buf = new Uint8Array(await file.arrayBuffer())
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  // 从尾部回扫找中央目录结束标记
  let eocd = -1
  const back = Math.min(buf.length, 65557)
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - back); i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('这不是有效的 zip 文件')

  const count = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  if (off === 0xffffffff || count === 0xffff) {
    throw new Error('不支持 zip64 格式的超大压缩包，请解压后逐个拖入')
  }
  if (count > MAX_ENTRIES) {
    throw new Error(`压缩包内文件过多（${count} 个），上限 ${MAX_ENTRIES}`)
  }

  const entries = []
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || dv.getUint32(off, true) !== CEN_SIG) break
    const flag = dv.getUint16(off + 8, true)
    const method = dv.getUint16(off + 10, true)
    const compSize = dv.getUint32(off + 20, true)
    const uncompSize = dv.getUint32(off + 24, true)
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const commentLen = dv.getUint16(off + 32, true)
    const localOff = dv.getUint32(off + 42, true)
    const rawName = buf.subarray(off + 46, off + 46 + nameLen)
    const name = flag & UTF8_FLAG ? new TextDecoder('utf-8').decode(rawName) : decodeName(rawName)
    entries.push({ name, method, compSize, uncompSize, localOff })
    off += 46 + nameLen + extraLen + commentLen
  }

  const out = new Map()
  let totalOut = 0
  for (const e of entries) {
    if (e.name.endsWith('/')) continue // 目录项
    const lo = e.localOff
    if (lo + 30 > buf.length || dv.getUint32(lo, true) !== LOC_SIG) continue
    const lNameLen = dv.getUint16(lo + 26, true)
    const lExtraLen = dv.getUint16(lo + 28, true)
    const dataStart = lo + 30 + lNameLen + lExtraLen
    if (dataStart < 0 || dataStart > buf.length || dataStart + e.compSize > buf.length) continue
    const data = buf.subarray(dataStart, dataStart + e.compSize)

    // 中央目录里声明的解压大小先过一遍，明显超标的直接跳过，连解都不解
    if (e.uncompSize > MAX_ENTRY_BYTES) {
      console.warn(`[zip] 跳过过大的文件 ${e.name}（声明 ${Math.round(e.uncompSize / 1048576)} MB）`)
      continue
    }

    let bytes
    if (e.method === 0) {
      bytes = data
    } else if (e.method === 8) {
      try {
        // 以声明大小 + 一点余量为上限；声明值造假也逃不过流式计数
        bytes = await inflateRaw(data, Math.min(MAX_ENTRY_BYTES, e.uncompSize + 1024 * 1024))
      } catch (err) {
        console.warn(`[zip] 解压失败 ${e.name}:`, err?.message || err)
        continue
      }
    } else {
      console.warn(`[zip] 跳过不支持的压缩方式(${e.method}): ${e.name}`)
      continue
    }
    totalOut += bytes.byteLength
    if (totalOut > MAX_TOTAL_BYTES) {
      throw new Error(`压缩包解压后超过 ${Math.round(MAX_TOTAL_BYTES / 1048576)} MB，请拆分后再导入`)
    }
    // 统一路径分隔符，去掉开头的 ./ 和目录前缀
    const key = e.name.replace(/\\/g, '/').replace(/^\.\//, '')
    out.set(key, { blob: new Blob([bytes]), size: bytes.byteLength })
  }

  if (!out.size) throw new Error('压缩包里没有可读取的文件')
  return out
}

/**
 * 把虚拟文件表变成 loader 能用的 URL 映射。
 * 返回 { manager, urls, revoke }，用完记得 revoke()。
 */
export function virtualFS(files, THREE) {
  const urls = new Map() // 规范化路径 → blob url
  const created = []

  for (const [path, f] of files) {
    const u = URL.createObjectURL(f.blob)
    urls.set(normalize(path), u)
    created.push(u)
  }

  function normalize(p) {
    return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '')
  }

  // 相对路径也要能命中：把「入口文件所在目录 + 相对路径」逐级化简
  function resolve(basePath, target) {
    const baseDir = normalize(basePath).split('/').slice(0, -1)
    const parts = normalize(target).split('/')
    const stack = [...baseDir]
    for (const seg of parts) {
      if (!seg || seg === '.') continue
      if (seg === '..') {
        if (stack.length > 0) stack.pop()
      } else {
        stack.push(seg)
      }
    }
    return stack.join('/')
  }

  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url
    const clean = url.replace(/^https?:\/\/[^/]+\//, '')
    const dec = (() => {
      try {
        return decodeURIComponent(clean)
      } catch {
        return clean
      }
    })()
    if (urls.has(dec)) return urls.get(dec)
    const base = dec.split('/').pop()
    // 退一步：只按文件名匹配（贴图常常被放在别的子目录）
    for (const [k, v] of urls) {
      if (k === base || k.endsWith('/' + base)) return v
    }
    return url
  })

  return {
    manager,
    urls,
    resolve,
    urlFor(p) {
      return urls.get(normalize(p)) || null
    },
    revoke() {
      for (const u of created) URL.revokeObjectURL(u)
      created.length = 0
    },
  }
}

/**
 * 在压缩包里挑出应当作为入口的模型文件，并返回它所在的目录
 */
export function pickEntry(files) {
  const paths = [...files.keys()]
  const order = ['.glb', '.gltf', '.dae', '.fbx', '.obj', '.ply', '.stl', '.3mf']
  for (const ext of order) {
    const hit = paths.filter((p) => p.toLowerCase().endsWith(ext))
    if (!hit.length) continue
    // 优先挑名字里带 house/户型/scene 之类，其次挑路径最浅的
    hit.sort((a, b) => {
      const score = (p) => {
        const n = p.toLowerCase()
        let s = n.split('/').length
        if (/(house|room|apartment|scene|model|户型|模型|房子)/.test(n)) s -= 2
        if (/(tree|light|camera|prop|家具|杂项)/.test(n)) s += 1
        return s
      }
      return score(a) - score(b)
    })
    return hit[0]
  }
  return null
}
