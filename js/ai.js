/* TRALIX EDITOR — local "AI" analysis (100% on-device, no API keys):
   scene detection (frame histogram cuts), smart highlights (audio energy peaks) */
import { urlReady } from './media.js';
import { detectBeats } from './audio.js';

/* Sample a video clip's frames and find scene-change source times */
export async function detectScenes(media, { maxSamples = 60, onProgress } = {}) {
  const url = await urlReady(media);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.src = url; v.preload = 'auto';
  await new Promise(res => { v.onloadeddata = res; v.onerror = res; setTimeout(res, 8000); });
  const dur = media.duration || v.duration || 0;
  if (!dur) return [];
  const W = 48, H = 27;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const seek = t => new Promise(res => {
    const done = () => { v.removeEventListener('seeked', done); setTimeout(res, 8); };
    v.addEventListener('seeked', done);
    v.currentTime = Math.min(Math.max(0, t), dur - 0.02);
    setTimeout(done, 1200);
  });
  const step = dur / (maxSamples + 1);
  const times = [];
  let prevHist = null, prevT = null;
  const diffs = [];
  const samples = [];
  for (let i = 1; i <= maxSamples; i++) {
    const t = i * step;
    await seek(t);
    try { ctx.drawImage(v, 0, 0, W, H); } catch { continue; }
    const hist = hist3(ctx.getImageData(0, 0, W, H).data);
    samples.push({ t, hist });
    if (onProgress) onProgress(i / maxSamples);
  }
  for (let i = 1; i < samples.length; i++) {
    const d = chi2(samples[i - 1].hist, samples[i].hist);
    diffs.push({ t: (samples[i - 1].t + samples[i].t) / 2, d });
  }
  if (!diffs.length) return [];
  diffs.sort((a, b) => a.d - b.d);
  const median = diffs[Math.floor(diffs.length / 2)].d;
  const thr = Math.max(0.35, median * 3.2);
  const cuts = diffs.filter(x => x.d >= thr).sort((a, b) => a.t - b.t);
  // de-dupe close cuts
  const out = [];
  for (const cu of cuts) {
    if (!out.length || cu.t - out[out.length - 1] > Math.max(0.8, step)) out.push(cu.t);
  }
  return out;
}

function hist3(data) {
  const h = new Float32Array(27);
  for (let i = 0; i < data.length; i += 4) {
    const r = Math.min(2, (data[i] / 86) | 0), g = Math.min(2, (data[i + 1] / 86) | 0), b = Math.min(2, (data[i + 2] / 86) | 0);
    h[r * 9 + g * 3 + b]++;
  }
  const n = data.length / 4;
  for (let i = 0; i < 27; i++) h[i] /= n;
  return h;
}
function chi2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    const den = a[i] + b[i];
    if (den > 1e-6) s += (d * d) / den;
  }
  return s;
}

/* Rank the loudest "moments" in an AudioBuffer (gunshots, kills, action peaks) */
export function findHighlights(audioBuffer, count = 8) {
  const ch = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const win = Math.floor(sr * 0.05);
  const n = Math.floor(ch.length / win);
  const env = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let sum = 0;
    const s = w * win;
    for (let i = s; i < s + win; i += 4) sum += ch[i] * ch[i];
    env[w] = Math.sqrt(sum / (win / 4));
  }
  // local maxima
  const peaks = [];
  for (let w = 2; w < n - 2; w++) {
    if (env[w] > env[w - 1] && env[w] >= env[w + 1] && env[w] > 0.02) {
      peaks.push({ t: w * 0.05, v: env[w] });
    }
  }
  // non-max suppression within 1.5s
  peaks.sort((a, b) => b.v - a.v);
  const chosen = [];
  for (const p of peaks) {
    if (chosen.length >= count) break;
    if (chosen.every(c => Math.abs(c.t - p.t) > 1.5)) chosen.push(p);
  }
  chosen.sort((a, b) => a.t - b.t);
  return chosen.map(c => c.t);
}

export { detectBeats };
