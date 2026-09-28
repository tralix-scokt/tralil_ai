/* TRALIX EDITOR — media library: import, probe (resolution/fps), decode audio,
   waveform peaks, thumbnails, persistent blob store, video element pool */
import { idb } from './idb.js';
import { uid, clamp } from './util.js';

export const mediaMap = new Map();   // id -> media record (in-memory)
const blobUrls = new Map();          // id -> objectURL
const audioBank = new Map();         // id -> AudioBuffer
const videoEls = new Map();          // clipId -> HTMLVideoElement

export async function importFiles(files, onProgress) {
  const out = [];
  const list = [...files].filter(f => /^(video|audio|image)\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|avi|m4a|mp3|wav|ogg|aac|flac|png|jpe?g|gif|webp|bmp)$/i.test(f.name));
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    try {
      onProgress && onProgress(i, list.length, f.name);
      const rec = await ingestFile(f);
      if (rec) out.push(rec);
    } catch (e) {
      console.warn('import failed', f.name, e);
    }
  }
  onProgress && onProgress(list.length, list.length, '');
  return out;
}

export async function ingestFile(file, opts = {}) {
  const id = uid();
  await idb.put('media', { id, blob: file, name: file.name, addedAt: Date.now() });
  const kind = file.type.startsWith('audio') || /\.(m4a|mp3|wav|ogg|aac|flac)$/i.test(file.name) ? 'audio'
    : file.type.startsWith('image') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name) ? 'image' : 'video';
  const rec = {
    id, kind, name: opts.name || file.name || 'clip', mime: file.type, size: file.size,
    duration: 0, width: 0, height: 0, fps: 30, hasAudio: false, peaks: null, thumb: null,
    fromVideo: !!opts.fromVideo, addedAt: Date.now(),
  };
  const url = urlFor(rec);
  if (kind === 'image') {
    await probeImage(rec);
  } else if (kind === 'video') {
    await probeVideo(rec, url);
    await makeThumb(rec, url);
  } else {
    const buf = await file.arrayBuffer();
    const actx = await audioCtx();
    let ab;
    try { ab = await actx.decodeAudioData(buf.slice(0)); }
    catch { await idb.delete('media', id); throw new Error('Unsupported audio format'); }
    audioBank.set(id, ab);
    rec.duration = ab.duration; rec.hasAudio = true;
    rec.peaks = computePeaks(ab, 1200);
  }
  mediaMap.set(id, rec);
  return rec;
}

export function urlFor(rec) {
  if (!blobUrls.has(rec.id)) {
    // blob comes from IDB store (we stored the File itself)
    blobUrls.set(rec.id, null);
    idb.get('media', rec.id).then(row => {
      if (row && row.blob) {
        const u = URL.createObjectURL(row.blob);
        blobUrls.set(rec.id, u);
        document.dispatchEvent(new CustomEvent('mediaurl', { detail: rec.id }));
      }
    });
    return null;
  }
  return blobUrls.get(rec.id);
}
export async function urlReady(rec) {
  let u = blobUrls.get(rec.id);
  if (u !== null && u !== undefined) return u;
  const row = await idb.get('media', rec.id);
  if (!row || !row.blob) throw new Error('Media data missing');
  u = URL.createObjectURL(row.blob);
  blobUrls.set(rec.id, u);
  return u;
}

async function probeImage(rec) {
  const url = await urlReady(rec);
  await new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      rec.width = img.naturalWidth; rec.height = img.naturalHeight;
      rec.thumb = url; res();
    };
    img.onerror = res;
    img.src = url;
    setTimeout(res, 8000);
  });
  // small preview thumb to keep memory low in grids
  try {
    const img2 = new Image();
    await new Promise(res => { img2.onload = res; img2.onerror = res; img2.src = url; setTimeout(res, 5000); });
    const scale = Math.min(1, 480 / Math.max(1, img2.naturalWidth));
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(img2.naturalWidth * scale));
    c.height = Math.max(2, Math.round(img2.naturalHeight * scale));
    c.getContext('2d').drawImage(img2, 0, 0, c.width, c.height);
    rec.thumb = c.toDataURL('image/jpeg', 0.8);
    // note: full-res loads via urlReady() when compositing
  } catch { }
}

async function probeVideo(rec, url) {
  const u = url || await urlReady(rec);
  const v = document.createElement('video');
  v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = u;
  await new Promise((res, rej) => {
    v.onloadedmetadata = res; v.onerror = () => rej(new Error('Cannot decode video'));
    setTimeout(res, 8000);
  });
  rec.duration = isFinite(v.duration) ? v.duration : 0;
  rec.width = v.videoWidth; rec.height = v.videoHeight;

  // fps estimate via requestVideoFrameCallback
  let fps = 0;
  if (v.requestVideoFrameCallback && rec.duration > 0.2) {
    try {
      await seekTo(v, Math.min(0.1, rec.duration / 4));
      const samples = [];
      await new Promise(res => {
        let last = null, n = 0;
        const step = (_now, meta) => {
          if (last !== null) samples.push(meta.mediaTime - last);
          last = meta.mediaTime;
          if (++n >= 24) return res();
          v.requestVideoFrameCallback(step);
        };
        v.requestVideoFrameCallback(step);
        v.play().catch(() => res());
        setTimeout(res, 1500);
      });
      v.pause();
      if (samples.length > 4) {
        samples.sort((a, b) => a - b);
        const med = samples[Math.floor(samples.length / 2)];
        if (med > 0.0005) fps = 1 / med;
      }
    } catch { /* ignore */ }
  }
  rec.fps = normalizeFps(fps || 0);

  // has-audio probe
  rec.hasAudio = await probeHasAudio(u, rec.mime);
  if (rec.hasAudio) {
    try {
      const blob = await idb.get('media', rec.id).then(r => r.blob);
      const buf = await blob.arrayBuffer();
      const actx = await audioCtx();
      const ab = await actx.decodeAudioData(buf);
      audioBank.set(rec.id, ab);
      rec.peaks = computePeaks(ab, 1200);
      // decoded duration may differ slightly; trust metadata but sanity check
      if (!rec.duration && ab.duration) rec.duration = ab.duration;
    } catch (e) { rec.hasAudio = false; }
  }
}

function normalizeFps(f) {
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 120, 240];
  let best = 30, bestD = Infinity;
  for (const c of common) { const d = Math.abs(c - f); if (d < bestD) { bestD = d; best = c; } }
  return bestD <= 2.5 ? best : Math.round(f);
}

async function probeHasAudio(url, mime) {
  // quick heuristic: try decoding a slice — if decodeAudioData succeeds we have sound
  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 60e6) return true; // assume yes for huge files (decoding skipped)
    const actx = await audioCtx();
    await actx.decodeAudioData(buf.slice(0));
    return true;
  } catch { return false; }
}

async function makeThumb(rec, url) {
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.src = url || await urlReady(rec);
    await new Promise((res) => { v.onloadeddata = res; v.onerror = res; setTimeout(res, 6000); });
    await seekTo(v, Math.min(0.4, (rec.duration || 1) * 0.15));
    const c = document.createElement('canvas');
    const scale = 320 / Math.max(1, v.videoWidth);
    c.width = Math.max(2, Math.round(v.videoWidth * scale));
    c.height = Math.max(2, Math.round(v.videoHeight * scale));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    rec.thumb = c.toDataURL('image/jpeg', 0.72);
  } catch { rec.thumb = null; }
}

function seekTo(v, t) {
  return new Promise(res => {
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    v.currentTime = Math.max(0, t);
    setTimeout(done, 4000);
  });
}

export function computePeaks(audioBuffer, buckets = 1200) {
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
  const n = ch0.length, per = Math.max(1, Math.floor(n / buckets));
  const peaks = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const s = b * per, e = Math.min(n, s + per);
    for (let i = s; i < e; i += 2) {
      const v = ch1 ? Math.max(Math.abs(ch0[i]), Math.abs(ch1[i])) : Math.abs(ch0[i]);
      if (v > m) m = v;
    }
    peaks[b] = m;
  }
  return peaks;
}

/* decoded AudioBuffer for any media (video files too) */
export async function getAudioBuffer(rec) {
  if (audioBank.has(rec.id)) return audioBank.get(rec.id);
  const row = await idb.get('media', rec.id);
  if (!row || !row.blob) return null;
  const buf = await row.blob.arrayBuffer();
  const actx = await audioCtx();
  try {
    const ab = await actx.decodeAudioData(buf);
    audioBank.set(rec.id, ab);
    if (!rec.peaks) rec.peaks = computePeaks(ab, 1200);
    return ab;
  } catch { return null; }
}
export function peekAudioBuffer(id) { return audioBank.get(id) || null; }

/* one muted <video> element per clip for frame supply */
export async function getVideoEl(clip, media) {
  let v = videoEls.get(clip.id);
  if (v) return v;
  const url = blobUrls.get(media.id) || await urlReady(media);
  v = document.createElement('video');
  v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  videoEls.set(clip.id, v);
  return v;
}
export function dropVideoEl(clipId) {
  const v = videoEls.get(clipId);
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); videoEls.delete(clipId); }
}
export function allVideoEls() { return [...videoEls.values()]; }

let _actx = null;
export function audioCtx() {
  if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
  if (_actx.state === 'suspended') _actx.resume().catch(() => { });
  return _actx;
}

export async function loadLibrary() {
  const rows = await idb.getAll('media');
  for (const row of rows) {
    if (mediaMap.has(row.id)) continue;
    const meta = await idb.kvGet('meta:' + row.id);
    if (meta) mediaMap.set(row.id, meta);
  }
}
export async function saveMediaMeta(rec) {
  const { peaks, ...serializable } = rec;
  const copy = { ...serializable, peaks: peaks ? Array.from(peaks) : null };
  await idb.kvSet('meta:' + rec.id, copy);
}

/* remove media from library if not used by any project clip */
export async function deleteMedia(id) { await idb.delete('media', id); mediaMap.delete(id); }

export async function extractAudioFromVideo(rec) {
  // decode video file audio into an "audio" media record (kept in library)
  const ab = await getAudioBuffer(rec);
  if (!ab) throw new Error('No decodable audio in this clip');
  const id = uid();
  const blob = await idb.get('media', rec.id).then(r => r.blob);
  await idb.put('media', { id, blob, name: rec.name.replace(/\.[^.]+$/, '') + ' (audio)', addedAt: Date.now() });
  const audioRec = {
    id, kind: 'audio', name: rec.name.replace(/\.[^.]+$/, '') + ' (audio)',
    mime: rec.mime, size: rec.size, duration: ab.duration, width: 0, height: 0, fps: 0,
    hasAudio: true, peaks: computePeaks(ab, 1200), thumb: null, fromVideo: true, addedAt: Date.now(),
  };
  audioBank.set(id, ab);
  mediaMap.set(id, audioRec);
  return audioRec;
}
