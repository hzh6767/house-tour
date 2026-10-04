// 生成测试用模型：一个 6m x 4m x 2.7m 的单间，单位故意用【毫米】，用来验证自动单位识别。
// 产出 models/test-room.glb 和 models/test-room.zip（zip 里放同一个 glb），供自动化测试用。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'models')
fs.mkdirSync(OUT, { recursive: true })

const MM = 1000
const W = 6 * MM, D = 4 * MM, H = 2.7 * MM, T = 120 // 墙厚 120mm
const positions = []
const indices = []
const normals = []

function quad(a, b, c, d, n) {
  const base = positions.length / 3
  for (const p of [a, b, c, d]) positions.push(...p)
  for (let i = 0; i < 4; i++) normals.push(...n)
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}
// 盒子：6 个面，法线朝外
function box(x0, y0, z0, x1, y1, z1) {
  quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],[0,0,1])
  quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[0,0,-1])
  quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[1,0,0])
  quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],[-1,0,0])
  quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0],[0,1,0])
  quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],[0,-1,0])
}
box(0, -100, 0, W, 0, D)                 // 地板（厚 100mm，顶面在 y=0）
box(0, 0, 0, W, H, T)                    // 北墙
box(0, 0, D - T, W, H, D)                // 南墙
box(0, 0, T, T, H, D - T)                // 西墙
// 东墙留一个 900mm 的门洞，门洞中心在 z = 2000
box(W - T, 0, T, W, H, 2000 - 450)
box(W - T, 0, 2000 + 450, W, H, D - T)
box(W - T, 2100, 2000 - 450, W, H, 2000 + 450) // 门洞上方的过梁
// 屋子中间放一个 800x800x750 的桌子，验证家具碰撞
box(2600, 0, 1600, 3400, 750, 2400)

const pos = new Float32Array(positions)
const nor = new Float32Array(normals)
const idx = new Uint16Array(indices)
let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i+k]); max[k] = Math.max(max[k], pos[i+k]) }

const pad4 = (n) => (n + 3) & ~3
const bufs = [Buffer.from(pos.buffer), Buffer.from(nor.buffer), Buffer.from(idx.buffer)]
const views = []
let off = 0
for (const b of bufs) { views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); off = pad4(off + b.length) }
const bin = Buffer.alloc(off)
for (let i = 0; i < bufs.length; i++) bufs[i].copy(bin, views[i].byteOffset)

const gltf = {
  asset: { version: '2.0', generator: 'house-tour test asset' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'TestRoom_mm' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.85, 0.82, 0.76, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
  ],
  bufferViews: views,
  buffers: [{ byteLength: bin.length }],
}
let json = Buffer.from(JSON.stringify(gltf), 'utf8')
while (json.length % 4) json = Buffer.concat([json, Buffer.from(' ')])
const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8)
const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4E4F534A, 4)
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4)
const glb = Buffer.concat([header, jh, json, bh, bin])
fs.writeFileSync(path.join(OUT, 'test-room.glb'), glb)
console.log(`models/test-room.glb  ${glb.length} bytes, ${idx.length / 3} triangles, units=mm`)

// ---- zip 版本 ----
function crc32(buf){let c,crc=0xFFFFFFFF;for(let n=0;n<buf.length;n++){c=(crc^buf[n])&0xFF;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xEDB88320:c>>>1;crc=(crc>>>8)^c}return (crc^0xFFFFFFFF)>>>0}
function zipOf(entries) {
  const parts = [], cen = []; let o = 0
  for (const [name, data] of entries) {
    const nameB = Buffer.from(name, 'utf8'), comp = zlib.deflateRawSync(data)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6); local.writeUInt16LE(8,8)
    local.writeUInt32LE(crc32(data),14); local.writeUInt32LE(comp.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(nameB.length,26)
    parts.push(local, nameB, comp)
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50,0); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x800,8); c.writeUInt16LE(8,10)
    c.writeUInt32LE(crc32(data),16); c.writeUInt32LE(comp.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(nameB.length,28); c.writeUInt32LE(o,42)
    cen.push(c, nameB); o += local.length + nameB.length + comp.length
  }
  const cenBuf = Buffer.concat(cen)
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(entries.length,8); eocd.writeUInt16LE(entries.length,10); eocd.writeUInt32LE(cenBuf.length,12); eocd.writeUInt32LE(o,16)
  return Buffer.concat([...parts, cenBuf, eocd])
}
const zip = zipOf([['户型/readme.txt', Buffer.from('test archive')], ['户型/test-room.glb', glb]])
fs.writeFileSync(path.join(OUT, 'test-room.zip'), zip)
console.log(`models/test-room.zip  ${zip.length} bytes`)
