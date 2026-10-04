// 通用小工具
export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export function clamp(v, lo, hi) {
  if (typeof v !== 'number' || isNaN(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a, b, t) {
  if (isNaN(a) || isNaN(b) || isNaN(t)) return a
  return a + (b - a) * t
}

// 帧率无关的指数平滑
export function damp(current, target, lambda, dt) {
  if (isNaN(current) || isNaN(target) || isNaN(lambda) || isNaN(dt)) return current
  return lerp(current, target, 1 - Math.exp(-lambda * dt))
}

export function formatBytes(n) {
  if (!n && n !== 0) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

export function formatDuration(sec) {
  if (typeof sec !== 'number' || isNaN(sec) || !isFinite(sec) || sec < 0) return '0 秒'
  if (sec < 60) return sec.toFixed(1) + ' 秒'
  const m = Math.floor(sec / 60)
  return m + ' 分 ' + Math.round(sec - m * 60) + ' 秒'
}

let toastTimer = null
export function toast(msg, ms = 2400) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = msg
  el.hidden = false
  // 强制重排，保证重复调用时动画会重放
  void el.offsetWidth
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => {
      if (!el.classList.contains('show')) el.hidden = true
    }, 260)
  }, ms)
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // http 环境下 clipboard API 不可用，退回到旧办法
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}

// URL 安全的 base64（用于把户型数据塞进分享链接）
export function b64encode(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64decode(b64) {
  try {
    let s = b64.replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4) s += '='
    const bin = atob(s)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch (e) {
    throw new Error('Invalid base64 input: ' + (e?.message || e))
  }
}

// 「主输入是手指」才算触屏设备。带触摸屏的 Windows 笔记本主指针仍是鼠标，
// 不能因为 maxTouchPoints > 0 就把它当手机，否则会丢掉鼠标锁定、还弹出摇杆。
export function isTouch() {
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true
  } catch {
    /* 老浏览器没有 matchMedia，往下走 */
  }
  const ua = navigator.userAgent || ''
  if (/Android|iPhone|iPad|iPod|HarmonyOS|MicroMessenger/i.test(ua)) return true
  // iPadOS 13+ 的 UA 伪装成 Mac，用触点数 + 平台兜底
  return /Mac/i.test(ua) && (navigator.maxTouchPoints || 0) > 1
}

export function isMobile() {
  return isTouch() || Math.min(window.innerWidth, window.innerHeight) < 500
}

// 估算设备的渲染档位，作为默认画质
export function detectQuality() {
  const mem = navigator.deviceMemory || navigator.hardwareConcurrency || 4
  const dpr = window.devicePixelRatio || 1
  const touch = isTouch()
  if (touch && (dpr > 2.5 || mem <= 4)) return 1 // 中低端手机
  if (touch) return 2 // 主流手机
  if (mem >= 8 && dpr <= 2) return 3 // 配置不错的桌面
  return 2
}

export function extOf(name) {
  const i = String(name).lastIndexOf('.')
  return i < 0 ? '' : String(name).slice(i).toLowerCase()
}

export function baseName(p) {
  return String(p).split(/[\\/]/).pop() || ''
}

export function stripExt(name) {
  const b = baseName(name)
  const i = b.lastIndexOf('.')
  return i <= 0 ? b : b.slice(0, i)
}

// 简易体积字符串（用于文件名后缀）
export function slug(name) {
  return baseName(name)
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w一-龥-]+/g, '-')
    .slice(0, 60)
}
