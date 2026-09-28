/* TRALIX EDITOR — utilities */
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, p) => a + (b - a) * p;

export function fmtTime(s, withMs = false) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  const base = `${m}:${String(sec).padStart(2, '0')}`;
  if (!withMs) return base;
  return `${base}.${String(Math.floor((s % 1) * 10))}`;
}
export function fmtDur(s) {
  if (!isFinite(s)) return '0s';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}
export function fmtBytes(b) {
  if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b > 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

/* Deterministic pseudo-random from an integer seed (mulberry32) — same value in preview & export */
export function srand(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
export const hash = (n) => { // fast integer hash -> [0,1)
  let x = Math.imul(n ^ 0x9E3779B9, 0x85EBCA6B); x ^= x >>> 13;
  x = Math.imul(x, 0xC2B2AE35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};
/* smooth 1D value noise, deterministic in frame index */
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const a = hash(i * 374761393 + seed * 668265263), b = hash((i + 1) * 374761393 + seed * 668265263);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

export function debounce(fn, ms) {
  let t; const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'dataset' && typeof v === 'object') { for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv; }
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

export function toast(msg, ms = 2200) {
  let host = document.getElementById('toasts');
  if (!host) { host = el('div', { id: 'toasts' }); document.body.append(host); }
  const t = el('div', { class: 'toast' }, msg);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 350); }, ms);
}

/* hsl/hex helpers */
export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

/* ease helpers used by animations & transitions */
export const easeOut = p => 1 - Math.pow(1 - p, 3);
export const easeIn = p => p * p * p;
export const easeInOut = p => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
export const easeBack = p => { const c = 1.70158; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };

/* wait for an <video>/<img>/decode to be usable */
export function onceEvent(target, ev) { return new Promise(res => target.addEventListener(ev, res, { once: true })); }
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* MIME probing for export */
export function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) { try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* ignore */ } }
  return null;
}
export function supports(op) {
  switch (op) {
    case 'export': return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
    case 'mic': return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    case 'share': return !!(navigator.canShare && navigator.share);
    default: return false;
  }
}
