/* TRALIX EDITOR — real export: canvas compositing + WebAudio mix -> MediaRecorder.
   No watermark. Saves to device (download / share) and to in-app "My Edits". */
import { el, toast, clamp, pickRecorderMime, supports, fmtBytes, fmtDur, uid } from './util.js';
import { idb } from './idb.js';
import { projectDuration } from './model.js';
import { Player } from './player.js';
import { audioEngine } from './audio.js';
import { openModal } from './dialogs.js';

const RESOLUTIONS = [
  { id: '720', label: '720p HD', w: 1280, h: 720 },
  { id: '1080', label: '1080p FHD', w: 1920, h: 1080 },
  { id: '1440', label: '1440p QHD', w: 2560, h: 1440 },
  { id: '2160', label: '4K UHD (if device supports)', w: 3840, h: 2160 },
];
const FRAMERATES = [24, 30, 60, 120];
const QUALITIES = [
  { id: 'standard', label: 'Standard', bpp: 0.055 },
  { id: 'high', label: 'High', bpp: 0.1 },
  { id: 'maximum', label: 'Maximum', bpp: 0.19 },
];

export function pickFormat() {
  const mime = pickRecorderMime();
  if (!mime) return null;
  return {
    mime,
    ext: mime.includes('mp4') ? 'mp4' : 'webm',
    label: mime.includes('mp4') ? 'MP4 (H.264)' : 'WebM (VP8/VP9)',
  };
}

export function openExportFlow(api) {
  const p = api.project();
  const dur = projectDuration(p);
  const fmt = pickFormat();
  if (!fmt || !supports('export')) {
    openModal({
      title: 'Export', width: 400,
      body: el('div', { class: 'stack' },
        el('p', { class: 'confirm-msg' }, 'This browser does not support in-browser video recording (MediaRecorder + canvas capture).'),
        el('p', { class: 'hint' }, 'Use Chrome (Android/desktop) or Safari 15+ (iOS) to export. Everything else in TRALIX EDITOR still works.'),
      ),
      actions: [{ label: 'OK', kind: 'ghost' }],
    });
    return;
  }

  const saved = p.exportSettings || null;
  let res = saved?.res || '1080';
  let fps = saved?.fps || Math.min(60, p.fps || 30);
  let quality = saved?.quality || 'high';
  const est = () => {
    const r = RESOLUTIONS.find(x => x.id === res);
    const q = QUALITIES.find(x => x.id === quality);
    const bitrate = clamp(r.w * r.h * fps * q.bpp, 1.5e6, 120e6);
    return bitrate;
  };
  const estLabel = el('div', { class: 'hint' });
  const updEst = () => {
    const mbps = (est() / 1e6).toFixed(1);
    const r = RESOLUTIONS.find(x => x.id === res);
    // canvas size sanity (device limits)
    const maxSize = Math.sqrt(maxCanvasPixels());
    const warn = r.w > maxSize ? '⚠ May exceed this device’s canvas limit — try a lower resolution.' : '';
    estLabel.innerHTML = `≈ ${mbps} Mbps · ${fmt.label} · ${fmtDur(dur)} render (real-time)<br>${warn || '<span class="ok">✓ No watermark — ever. Free forever.</span>'}`;
  };

  const body = el('div', { class: 'stack' });
  body.append(
    el('div', { class: 'field-label' }, 'Resolution'),
    segRow(RESOLUTIONS.map(r => ({ id: r.id, label: r.label })), res, id => { res = id; updEst(); }),
    el('div', { class: 'field-label' }, 'Frame rate'),
    segRow(FRAMERATES.map(f => ({ id: String(f), label: f + ' FPS' })), String(fps), id => { fps = Number(id); updEst(); }),
    el('div', { class: 'field-label' }, 'Quality (bitrate)'),
    segRow(QUALITIES.map(q => ({ id: q.id, label: q.label })), quality, id => { quality = id; updEst(); }),
    el('div', { class: 'hint' }, 'Format: ' + fmt.label + ' (auto-detected). Audio: AAC/Opus 192 kbps mix of all tracks.'),
    estLabel,
  );
  updEst();

  openModal({
    title: 'Export Video', width: 520, body,
    actions: [{ label: '🚀 Export & Save', kind: 'primary', onclick: () => runExport(api, { res, fps, quality, fmt }) }, { label: 'Cancel', kind: 'ghost' }],
  });
}

function segRow(options, active, onPick) {
  const host = el('div', { class: 'seg wrap' });
  for (const o of options) {
    const b = el('button', { class: 'seg-btn' + (o.id === active ? ' on' : '') }, o.label);
    b.addEventListener('click', () => { host.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('on')); b.classList.add('on'); onPick(o.id); });
    host.append(b);
  }
  return host;
}

function maxCanvasPixels() {
  const c = document.createElement('canvas');
  let lo = 1, hi = 8192;
  // probe common sizes instead of binary search (cheap)
  for (const s of [4096, 3840, 3000, 2048]) {
    c.width = s; c.height = s;
    const ok = c.getContext('2d') !== null;
    if (ok) return s * s;
  }
  return 1920 * 1080;
}

async function runExport(api, { res, fps, quality, fmt }) {
  const p = api.project();
  p.exportSettings = { res, fps, quality }; // remembered per project
  const dur = projectDuration(p);
  const r = RESOLUTIONS.find(x => x.id === res);
  const q = QUALITIES.find(x => x.id === quality);

  // pause preview player & mute speakers during render
  api.player.pause();

  const canvas = document.createElement('canvas');
  canvas.width = r.w; canvas.height = r.h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const exPlayer = new Player(api.project, canvas);
  exPlayer.muted = true;
  audioEngine.ensureGraph();
  audioEngine.setSpeakerMuted(true);

  const stream = canvas.captureStream(fps);
  for (const t of audioEngine.exportAudioTracks()) stream.addTrack(t);

  const bitrate = clamp(r.w * r.h * fps * q.bpp, 1.5e6, 120e6);
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
  } catch (e) {
    audioEngine.setSpeakerMuted(false);
    toast('Recorder failed to start: ' + e.message);
    return;
  }
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

  // progress UI
  const bar = el('div', { class: 'progress-bar' }, el('div', { class: 'progress-fill' }));
  const fill = bar.firstChild;
  const status = el('div', { class: 'hint center' }, 'Rendering… keep this screen open.');
  const pct = el('div', { class: 'big-num' }, '0%');
  let cancelled = false;
  const modal = openModal({
    title: 'Exporting', width: 440,
    body: el('div', { class: 'stack' }, pct, bar, status),
    actions: [{
      label: 'Cancel', kind: 'danger', onclick: () => { cancelled = true; finish(); },
    }],
    onClose: () => { cancelled = true; },
  });

  exPlayer.onFrame = (t) => {
    const pr = Math.min(1, t / Math.max(0.1, dur));
    fill.style.width = (pr * 100).toFixed(1) + '%';
    pct.textContent = Math.round(pr * 100) + '%';
    status.textContent = `Rendering ${fmtTimeStr(t)} / ${fmtTimeStr(dur)} — keep this screen open for a perfect render.`;
  };

  let stopResolver;
  const stopped = new Promise(res => { stopResolver = res; });
  recorder.onstop = () => stopResolver();
  let playbackEnded = false;
  exPlayer.onEnd = () => { playbackEnded = true; };

  recorder.start(400);
  await exPlayer.play(0);
  // wait for playback end or cancel
  await new Promise(resolve => {
    const iv = setInterval(() => {
      if (playbackEnded || cancelled || !exPlayer.playing && exPlayer.t >= dur - 0.05) { clearInterval(iv); resolve(); }
    }, 100);
    exPlayer._exportWait = resolve;
  });
  // small tail so the last frames land in the muxer
  await new Promise(r2 => setTimeout(r2, 350));
  recorder.stop();
  await stopped;
  exPlayer.pause();
  stream.getTracks().forEach(t => { if (t.kind === 'video') t.stop(); });
  audioEngine.setSpeakerMuted(false);

  if (cancelled) { toast('Export cancelled'); modal.close(); return; }
  const blob = new Blob(chunks, { type: fmt.mime.split(';')[0] });
  modal.close();
  showResult(api, blob, r, fps, fmt);
}

function fmtTimeStr(s) { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

function showResult(api, blob, res, fps, fmt) {
  const url = URL.createObjectURL(blob);
  const video = el('video', { src: url, controls: '', playsInline: '', style: { width: '100%', maxHeight: '38vh', background: '#000' } });
  const info = el('div', { class: 'hint center' }, `${res.w}×${res.h} · ${fps}fps · ${fmtBytes(blob.size)} · ${fmt.label}`);

  const meta = {
    id: uid(), name: `${api.project().name}.${fmt.ext}`,
    blob, size: blob.size, width: res.w, height: res.h, fps,
    createdAt: Date.now(), projectId: api.project().id, mime: blob.type,
  };
  // auto-save into My Edits (stays on device)
  idb.put('exports', meta).catch(() => { });

  openModal({
    title: '✅ Export Complete', width: 520,
    body: el('div', { class: 'stack' }, video, info,
      el('div', { class: 'hint center ok' }, 'No watermark. Your video, your rules.')),
    actions: [
      {
        label: '⬇ Save to device', kind: 'primary', closes: false, onclick: async () => {
          try {
            const a = document.createElement('a');
            a.href = url; a.download = meta.name;
            document.body.append(a); a.click(); a.remove();
            toast('Saved to your downloads/gallery');
          } catch (e) { toast('Download failed: ' + e.message); }
        },
      },
      supports('share') ? {
        label: '↗ Share', kind: 'ghost', closes: false, onclick: async () => {
          try {
            const file = new File([blob], meta.name, { type: blob.type });
            if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: meta.name });
            else toast('Sharing not available for this file');
          } catch (e) { /* user cancelled */ }
        },
      } : null,
      {
        label: '💾 My Edits ✓', kind: 'ghost', closes: false, onclick: async () => {
          await idb.put('exports', meta);
          toast('Saved in TRALIX · My Edits');
        },
      },
      { label: 'Close', kind: 'ghost', onclick: () => URL.revokeObjectURL(url) },
    ],
  });
  video.play().catch(() => { });
}

/* preload export screen (dynamic import guard) */
export const EXPORT_READY = Promise.resolve();
