// 模型载入。支持 .glb/.gltf/.obj/.fbx/.stl/.ply/.dae/.3mf 以及打包好的 .zip。
// 载入后统一做归一化：单位换算、居中、落地、材质修正、统计信息。
import * as THREE from 'three'
import { unzip, virtualFS, pickEntry } from './zip.js'
import { extOf, baseName, stripExt, formatBytes } from './util.js'

export const MODEL_EXT = ['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply', '.dae', '.3mf']
export const ZIP_EXT = ['.zip']
export const ACCEPT = [...MODEL_EXT, ...ZIP_EXT, '.mtl', '.bin', '.png', '.jpg', '.jpeg', '.webp', '.ktx2'].join(',')

const LIB = new URL('../vendor/three/examples/jsm/', import.meta.url).href

let _renderer = null
export function setRenderer(r) {
  _renderer = r
}

/* ───────────── 解码器（Draco / KTX2 / meshopt） ───────────── */

let _draco = null
let _ktx2 = null
let _meshopt = null

async function getDraco() {
  if (_draco) return _draco
  const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js')
  const d = new DRACOLoader()
  d.setDecoderPath(LIB + 'libs/draco/gltf/')
  _draco = d
  return d
}

async function getKTX2() {
  if (_ktx2) return _ktx2
  if (!_renderer) return null
  try {
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js')
    const k = new KTX2Loader()
    k.setTranscoderPath(LIB + 'libs/basis/')
    k.detectSupport(_renderer)
    _ktx2 = k
    return k
  } catch (err) {
    console.warn('[loader] KTX2 不可用:', err?.message || err)
    return null
  }
}

async function getMeshopt() {
  if (_meshopt) return _meshopt
  try {
    const mod = await import('three/addons/libs/meshopt_decoder.module.js')
    _meshopt = mod.MeshoptDecoder || null
    return _meshopt
  } catch {
    return null
  }
}

/* ───────────── 进度 ───────────── */

function makeManager(onProgress) {
  const m = new THREE.LoadingManager()
  m.onProgress = (url, loaded, total) => {
    if (onProgress && total > 0) onProgress(Math.round((loaded / total) * 100), baseName(url))
  }
  m.onError = (url) => console.warn('[loader] 资源加载失败:', url)
  return m
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  if (!res.body || !total) return res.arrayBuffer()

  const reader = res.body.getReader()
  const chunks = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress?.(Math.min(99, Math.round((received / total) * 100)), `${formatBytes(received)} / ${formatBytes(total)}`)
  }
  const out = new Uint8Array(received)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out.buffer
}

/* ───────────── 各格式 ───────────── */

async function loadGLTF(buffer, path, manager, onError) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  const loader = new GLTFLoader(manager)
  const draco = await getDraco()
  if (draco) loader.setDRACOLoader(draco)
  const ktx2 = await getKTX2()
  if (ktx2) loader.setKTX2Loader(ktx2)
  const meshopt = await getMeshopt()
  if (meshopt) loader.setMeshoptDecoder(meshopt)

  return new Promise((resolve, reject) => {
    loader.parse(
      buffer,
      path,
      (gltf) => resolve({ object: gltf.scene, animations: gltf.animations || [], gltf }),
      (err) => reject(err || new Error('GLTF 解析失败'))
    )
  })
}

async function loadOBJ(text, manager, mtlText = null, mtlName = null) {
  const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js')
  const loader = new OBJLoader(manager)

  if (mtlText) {
    const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js')
    const ml = new MTLLoader(manager)
    try {
      const materials = ml.parse(mtlText, '')
      materials.preload()
      loader.setMaterials(materials)
    } catch (err) {
      console.warn('[loader] MTL 解析失败，使用默认材质:', err?.message || err)
    }
  }

  const obj = loader.parse(text)
  return { object: obj, animations: [] }
}

async function loadFBX(buffer, path, manager) {
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js')
  const loader = new FBXLoader(manager)
  const obj = loader.parse(buffer, path)
  return { object: obj, animations: obj.animations || [] }
}

async function loadSTL(buffer) {
  const { STLLoader } = await import('three/addons/loaders/STLLoader.js')
  const loader = new STLLoader()
  const geo = loader.parse(buffer)
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xdad7d1, roughness: 0.72, metalness: 0.02 })
  )
  mesh.castShadow = true
  mesh.receiveShadow = true
  return { object: mesh, animations: [] }
}

async function loadPLY(buffer) {
  const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js')
  const loader = new PLYLoader()
  const geo = loader.parse(buffer)
  geo.computeVertexNormals()
  const hasColor = !!geo.attributes.color
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: hasColor ? 0xffffff : 0xcfd3d8,
      vertexColors: hasColor,
      roughness: 0.8,
      metalness: 0.02,
    })
  )
  mesh.castShadow = true
  mesh.receiveShadow = true
  return { object: mesh, animations: [] }
}

async function loadDAE(text, path, manager) {
  const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js')
  const loader = new ColladaLoader(manager)
  const res = loader.parse(text, path)
  if (!res || !res.scene) throw new Error('Collada 解析失败')
  return { object: res.scene, animations: res.animations || [] }
}

/* ───────────── 归一化 ───────────── */

const LIGHTS_AND_CAMERAS = /^(Light|Camera|AmbientLight|DirectionalLight|PointLight|SpotLight|HemisphereLight|PerspectiveCamera|OrthographicCamera)$/

/**
 * 把导入的场景整理成适合步行的形态。
 * @returns {{ bounds: THREE.Box3, stats: object, autoScale: number, size: THREE.Vector3 }}
 */
export function normalizeImported(object, opts = {}) {
  const { autoUnit = true, targetSpan = 14, orientation = 0 } = opts

  // 1) 先转朝向
  if (orientation) object.rotation.x = orientation

  // 2) 剔除相机、灯光、骨骼辅助物
  const trash = []
  object.traverse((o) => {
    if (LIGHTS_AND_CAMERAS.test(o.type) || o.isCamera || o.isLight || o.isSkeletonHelper || o.isLightProbe) {
      trash.push(o)
    }
  })
  for (const o of trash) o.parent?.remove(o)

  object.updateMatrixWorld(true)

  // 3) 单位识别
  let box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) throw new Error('模型里没有可显示的几何体')

  let size = box.getSize(new THREE.Vector3())
  let span = Math.max(size.x, size.z, size.y)
  let autoScale = 1

  if (autoUnit && span > 0.001) {
    // 反复乘/除 10，把尺寸拉进 3~45 米的合理区间
    let guard = 0
    while (span > 45 && guard++ < 8) {
      span /= 10
      autoScale /= 10
    }
    guard = 0
    while (span < 3 && guard++ < 8) {
      span *= 10
      autoScale *= 10
    }
  }

  if (autoScale !== 1) {
    object.scale.multiplyScalar(autoScale)
    object.updateMatrixWorld(true)
    box = new THREE.Box3().setFromObject(object)
    size = box.getSize(new THREE.Vector3())
  }

  // 4) 居中并落地
  const center = box.getCenter(new THREE.Vector3())
  object.position.x -= center.x
  object.position.z -= center.z
  object.position.y -= box.min.y
  object.updateMatrixWorld(true)

  // 5) 材质修正
  let meshes = 0
  let tris = 0
  let materials = new Set()
  let textures = new Set()

  object.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) return
    meshes++
    const g = o.geometry
    if (g) {
      const c = g.index ? g.index.count : g.attributes.position?.count || 0
      tris += Math.floor(c / 3)
      if (!g.attributes.normal) g.computeVertexNormals()
      if (!g.boundingSphere) g.computeBoundingSphere()
    }
    o.castShadow = true
    o.receiveShadow = true
    const list = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of list) {
      if (!m) continue
      materials.add(m)
      if (m.map) textures.add(m.map)
      if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.9
      // 单面材质从屋里往外看会漏，统一改成双面
      if (m.side === THREE.FrontSide) m.side = THREE.DoubleSide
      m.shadowSide = THREE.DoubleSide
      if (m.transparent && m.opacity > 0.85) {
        m.transparent = false
        m.opacity = 1
      }
    }
  })

  const stats = {
    meshes,
    triangles: tris,
    materials: materials.size,
    textures: textures.size,
  }

  return { bounds: new THREE.Box3().setFromObject(object), stats, autoScale, size }
}

/* ───────────── 对外入口 ───────────── */

/**
 * 载入单个文件（或压缩包）。
 * @param {File} file
 * @param {{ onProgress?: (pct:number, label:string)=>void, onStage?: (text:string)=>void }} ui
 */
export async function loadModelFile(file, ui = {}) {
  const ext = extOf(file.name)
  const { onProgress, onStage } = ui

  onStage?.(`读取 ${file.name}（${formatBytes(file.size)}）`)
  onProgress?.(2, '')

  if (ZIP_EXT.includes(ext)) {
    return loadFromZip(file, ui)
  }

  if (!MODEL_EXT.includes(ext)) {
    throw new Error(`不支持的文件格式：${ext || '未知'}（支持 ${MODEL_EXT.join(' ')} 和 .zip）`)
  }

  const raw = await readWithProgress(file, (p) => onProgress?.(Math.max(2, Math.round(p * 0.85)), ''))
  onStage?.('解析模型…')
  onProgress?.(90, '')

  const manager = makeManager(onProgress)
  const fileName = file.name
  const dir = fileName.includes('/') ? fileName.slice(0, fileName.lastIndexOf('/') + 1) : ''

  const result = await dispatch(ext, raw, file, dir, manager)
  onProgress?.(100, '')
  return finalize(result, file.name, file.size)
}

function readWithProgress(file, onPct) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onprogress = (e) => {
      if (e.lengthComputable) onPct((e.loaded / e.total) * 100)
    }
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error('读取文件失败'))
    fr.readAsArrayBuffer(file)
  })
}

async function dispatch(ext, raw, file, dir, manager) {
  switch (ext) {
    case '.glb':
      return loadGLTF(raw, dir, manager)
    case '.gltf': {
      const text = new TextDecoder().decode(raw)
      return loadGLTF(text, dir, manager)
    }
    case '.obj': {
      const text = new TextDecoder().decode(raw)
      return loadOBJ(text, manager)
    }
    case '.fbx':
      return loadFBX(raw, dir, manager)
    case '.stl':
      return loadSTL(raw)
    case '.ply':
      return loadPLY(raw)
    case '.dae':
      return loadDAE(new TextDecoder().decode(raw), dir, manager)
    case '.3mf': {
      const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js')
      const loader = new ThreeMFLoader()
      return { object: loader.parse(raw), animations: [] }
    }
    default:
      throw new Error('不支持该格式：' + ext)
  }
}

function finalize(result, sourceName, sizeBytes = null) {
  const object = result.object
  if (!object) throw new Error('模型内容为空')
  object.name = object.name || stripExt(sourceName)
  const norm = normalizeImported(object)
  return {
    object,
    animations: (result.animations || []).length,
    sourceName,
    sizeBytes,
    ...norm,
  }
}

/**
 * 从 zip 里读模型：解压 → 建虚拟文件系统 → 找到入口文件 → 载入
 * 这样贴图和 .bin 都能被自动找到
 */
export async function loadFromZip(file, ui = {}) {
  const { onProgress, onStage } = ui
  onStage?.(`解压 ${file.name}（${formatBytes(file.size)}）`)
  onProgress?.(4, '')

  const files = await unzip(file)
  onProgress?.(30, '')
  onStage?.(`压缩包内 ${files.size} 个文件，准备虚拟目录…`)

  const entry = pickEntry(files)
  if (!entry) throw new Error('压缩包里没找到模型文件（.glb/.gltf/.obj/.fbx/.stl/.ply/.dae）')

  const vfs = virtualFS(files, THREE)
  const manager = vfs.manager
  const ext = extOf(entry)
  const dir = entry.slice(0, entry.lastIndexOf('/') + 1)
  const entryUrl = vfs.urlFor(entry)
  if (!entryUrl) throw new Error('无法定位入口文件：' + entry)

  onStage?.(`解析 ${baseName(entry)}…`)
  onProgress?.(55, '')

  try {
    let result
    if (ext === '.obj') {
      const text = await new Response(files.get(entry).blob).text()
      // 找同目录的 .mtl
      const mtlName = (text.match(/^\s*mtllib\s+(.+)$/m) || [])[1]?.trim()
      let mtlText = null
      if (mtlName) {
        const key = vfs.resolve(entry, mtlName)
        const f = files.get(key) || [...files.entries()].find(([k]) => k.endsWith('/' + mtlName))?.[1]
        if (f) mtlText = await new Response(f.blob).text()
      }
      result = await loadOBJ(text, manager, mtlText, mtlName)
    } else if (ext === '.glb' || ext === '.fbx' || ext === '.stl' || ext === '.ply' || ext === '.3mf') {
      const buf = await new Response(files.get(entry).blob).arrayBuffer()
      result = await dispatch(ext, buf, { name: entry }, dir, manager)
    } else {
      const text = await new Response(files.get(entry).blob).text()
      result = await dispatch(ext, new TextEncoder().encode(text).buffer, { name: entry }, dir, manager)
    }

    onProgress?.(100, '')
    const out = finalize(result, entry, file.size)
    out.archiveName = file.name
    out.entry = entry
    out.contained = files.size
    // 文件系统要留着，贴图可能还在异步加载；交给调用方在换场景时回收
    out._vfs = vfs
    return out
  } catch (err) {
    vfs.revoke()
    throw err
  }
}

/**
 * 从服务器上的 URL 载入（用已有的模型文件）
 */
export async function loadModelUrl(url, ui = {}) {
  const { onProgress, onStage } = ui
  const name = baseName(url)
  const ext = extOf(name)

  if (ext === '.zip') {
    onStage?.(`下载 ${name}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const f = new File([blob], name, { type: 'application/zip' })
    return loadFromZip(f, ui)
  }

  if (!MODEL_EXT.includes(ext)) throw new Error('不支持该格式：' + ext)

  onStage?.(`下载 ${name}`)
  const buf = await fetchWithProgress(url, onProgress)
  onProgress?.(85, '')
  onStage?.('解析模型…')

  const manager = makeManager(onProgress)
  const dir = url.slice(0, url.lastIndexOf('/') + 1)
  const result = await dispatch(ext, buf, { name }, dir, manager)
  onProgress?.(100, '')
  const out = finalize(result, name, buf.byteLength)
  out.url = url
  return out
}

export function disposeLoaded(loaded) {
  if (!loaded) return
  loaded._vfs?.revoke()
  const obj = loaded.object || loaded.root || (loaded.isObject3D ? loaded : null)
  if (!obj) return
  const geos = new Set()
  const mats = new Set()
  const texs = new Set()
  obj.traverse((o) => {
    if (o.geometry) {
      geos.add(o.geometry)
      // 顺手清掉碰撞用的 BVH，别占内存
      o.geometry.boundsTree?.dispose?.()
      o.geometry.boundsTree = null
    }
    const list = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of list) {
      if (!m) continue
      mats.add(m)
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap',
        'bumpMap', 'displacementMap', 'specularMap', 'lightMap', 'envMap', 'clearcoatMap',
        'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
        'iridescenceMap', 'iridescenceThicknessMap', 'transmissionMap', 'thicknessMap']) {
        if (m[k]) texs.add(m[k])
      }
    }
  })
  for (const t of texs) t.dispose?.()
  for (const m of mats) m.dispose?.()
  for (const g of geos) g.dispose?.()
  obj.removeFromParent()
}
