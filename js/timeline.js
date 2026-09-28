/* TRALIX EDITOR — professional timeline: multi-track, drag/trim/split, zoom, snapping,
   waveforms, beat markers, pinch zoom */
import { clipDuration, clipsSorted, projectDuration, snapTargets, snapTime, findClip } from './model.js';
import { mediaMap } from './media.js';
import { clamp, fmtTime, el } from './util.js';

const TRACK_H = { text: 34, overlay: 34, video: 52, audio: 44 };
const HEADER_W = 84;

export class Timeline {
  constructor(host, getProject, hooks = {}) {
    this.host = host;
    this.getProject = getProject;
    this.hooks = hooks;
    this.pxPerSec = 60;
    this.selected = null; // clipId
    this.selTrack = null;
    this.build();
  }

  build() {
    this.host.innerHTML = '';
    this.wrap = el('div', { class: 'tl-wrap' });
    this.inner = el('div', { class: 'tl-inner' });
    this.rulerCanvas = el('canvas', { class: 'tl-ruler' });
    this.tracksHost = el('div', { class: 'tl-tracks' });
    this.playhead = el('div', { class: 'tl-playhead' }, el('div', { class: 'tl-ph-cap' }));
    this.inner.append(this.rulerCanvas, this.tracksHost, this.playhead);
    this.wrap.append(this.inner);
    this.host.append(this.wrap);

    this._pointers = new Map();
    this._pinch = null;
    this.wrap.addEventListener('pointerdown', e => this.onPointerDown(e));
    this.wrap.addEventListener('pointermove', e => this.onPointerMove(e));
    this.wrap.addEventListener('pointerup', e => this.onPointerUp(e));
    this.wrap.addEventListener('pointercancel', e => this.onPointerUp(e));
    this.wrap.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = this.wrap.getBoundingClientRect();
        this.zoom(this.pxPerSec * (e.deltaY < 0 ? 1.15 : 0.87), e.clientX - rect.left);
      }
    }, { passive: false });
  }

  /* ---------- layout ---------- */
  duration() { return Math.max(6, projectDuration(this.getProject()) + 2); }

  displayTracks() {
    const p = this.getProject();
    const vids = p.tracks.filter(t => t.kind === 'video').reverse();
    const auds = p.tracks.filter(t => t.kind === 'audio').reverse();
    const texts = p.tracks.filter(t => t.kind === 'text');
    const overs = p.tracks.filter(t => t.kind === 'overlay');
    return [...texts, ...overs, ...vids, ...auds];
  }

  layout() {
    const p = this.getProject();
    const dur = this.duration();
    const totalW = Math.ceil(dur * this.pxPerSec) + 24;
    this.inner.style.width = totalW + 'px';

    // ruler
    const h = 26;
    this.rulerCanvas.width = totalW * Math.min(2, devicePixelRatio || 1);
    this.rulerCanvas.height = h * Math.min(2, devicePixelRatio || 1);
    this.rulerCanvas.style.width = totalW + 'px';
    this.rulerCanvas.style.height = h + 'px';
    this.drawRuler();

    // tracks
    this.tracksHost.innerHTML = '';
    for (const track of this.displayTracks()) {
      const row = el('div', { class: `tl-track kind-${track.kind}` + (track.hidden ? ' hidden' : '') });
      row.style.height = (TRACK_H[track.kind] || 40) + 'px';
      row.dataset.trackId = track.id;
      const spacer = el('div', { class: 'tl-header' });
      spacer.style.width = HEADER_W + 'px';
      spacer.append(el('span', { class: 'tl-header-name' }, track.name), el('span', { class: 'tl-header-hint' }, track.kind === 'video' ? '⣿' : track.kind === 'audio' ? '♪' : track.kind === 'text' ? 'T' : '▣'));
      row.append(spacer);
      for (const clip of clipsSorted(track)) {
        row.append(this.clipEl(track, clip));
      }
      this.tracksHost.append(row);
    }
    this.updatePlayhead(this._lastT || 0);
    if (this.selected) this.restoreSelection();
  }

  drawRuler() {
    const c = this.rulerCanvas.getContext('2d');
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = this.rulerCanvas.width, H = this.rulerCanvas.height;
    c.clearRect(0, 0, W, H);
    c.scale(dpr, dpr);
    const h = 26;
    const px = this.pxPerSec;
    let step = 1;
    for (const s of [0.2, 0.5, 1, 2, 5, 10, 30, 60]) { if (px * s >= 56) { step = s; break; } step = s; }
    const sub = px * step >= 110 ? step / (step >= 1 ? (step === 1 ? 2 : 2) : 2) : 0;
    c.font = '10px "Chakra Petch", monospace';
    c.fillStyle = '#5d6b8c';
    c.strokeStyle = '#2a3350';
    c.lineWidth = 1;
    const end = (this.rulerCanvas.width / dpr) / px;
    for (let t = 0; t <= end; t += step) {
      const x = t * px;
      c.beginPath(); c.moveTo(x, h - 8); c.lineTo(x, h); c.stroke();
      c.fillText(fmtTime(t), x + 3, 11);
      if (sub > 0) {
        for (let s = 1; s < step / sub; s++) {
          const x2 = (t + s * sub) * px;
          c.beginPath(); c.moveTo(x2, h - 4); c.lineTo(x2, h); c.stroke();
        }
      }
    }
    // beat markers
    const p = this.getProject();
    c.fillStyle = '#00e5ff';
    for (const m of p.markers) {
      const x = m * px;
      c.fillRect(x - 1, 0, 2, h - 6);
      c.beginPath(); c.moveTo(x - 4, 0); c.lineTo(x + 4, 0); c.lineTo(x, 6); c.closePath(); c.fill();
    }
  }

  clipEl(track, clip) {
    const d = clipDuration(clip);
    const w = Math.max(8, d * this.pxPerSec);
    const media = clip.mediaId ? mediaMap.get(clip.mediaId) : null;
    const kids = [];
    let label = '';
    if (clip.kind === 'video') label = media ? media.name.replace(/\.[^.]+$/, '') : 'missing';
    if (clip.kind === 'audio') label = media ? media.name.replace(/\.[^.]+$/, '') : 'missing';
    if (clip.kind === 'text') label = 'T · ' + (clip.text || '').split('\n')[0].slice(0, 22);
    if (clip.kind === 'still') label = '❄ Freeze';
    if (clip.kind === 'overlay') label = '▣ ' + (clip.sub || 'overlay');

    if ((clip.kind === 'video' || clip.kind === 'ovl') && media && media.thumb) kids.push(el('div', { class: 'clip-thumb', style: { backgroundImage: `url(${media.thumb})` } }));
    if ((clip.kind === 'audio' || (clip.kind === 'video' && media && media.hasAudio)) && media && media.peaks) {
      const cv = el('canvas', { class: 'clip-wave' });
      kids.push(cv);
      setTimeout(() => this.drawWave(cv, clip, media), 0);
    }
    const speedBadge = (clip.speed && clip.speed !== 1) ? el('span', { class: 'clip-speed' }, clip.speed + '×') : null;
    const fxCount = (clip.effects && clip.effects.length) ? el('span', { class: 'clip-fx' }, 'fx' + clip.effects.length) : null;

    const c = el('div', {
      class: `tl-clip ${clip.kind === 'ovl' ? 'ovl' : clip.kind}` + (clip.muted ? ' muted' : '') + (clip.id === this.selected ? ' selected' : ''),
      dataset: { clipId: clip.id },
      style: { left: (HEADER_W + clip.start * this.pxPerSec) + 'px', width: w + 'px' },
    },
      ...kids,
      el('div', { class: 'clip-label' }, label),
      el('div', { class: 'clip-dur' }, d.toFixed(1) + 's'),
      speedBadge, fxCount,
      el('div', { class: 'trim-handle left' }),
      el('div', { class: 'trim-handle right' }),
    );
    c.dataset.trackId = track.id;
    return c;
  }

  drawWave(cv, clip, media) {
    const px = this.pxPerSec;
    const d = clipDuration(clip);
    const w = Math.max(10, Math.min(3000, Math.round(d * px)));
    const h = cv.parentElement ? cv.parentElement.clientHeight - 14 : 30;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = 'rgba(0,229,255,0.55)';
    const peaks = media.peaks;
    if (!peaks) return;
    const total = media.duration || 1;
    const t0 = clip.in, t1 = clip.out;
    const buckets = w;
    for (let i = 0; i < buckets; i++) {
      const tt = t0 + (i / buckets) * (t1 - t0);
      const idx = Math.min(peaks.length - 1, Math.floor((tt / total) * peaks.length));
      const v = peaks[idx] || 0;
      const bh = Math.max(1, v * h * 0.9);
      ctx.fillRect(i, (h - bh) / 2, 1, bh);
    }
  }

  restoreSelection() {
    const found = findClip(this.getProject(), this.selected);
    if (!found) { this.selected = null; this.selTrack = null; return; }
    const c = this.host.querySelector(`[data-clip-id="${this.selected}"]`);
    if (c) c.classList.add('selected');
  }

  select(clipId) {
    this.selected = clipId;
    this.host.querySelectorAll('.tl-clip.selected').forEach(n => n.classList.remove('selected'));
    if (clipId) {
      const c = this.host.querySelector(`[data-clip-id="${clipId}"]`);
      if (c) c.classList.add('selected');
    }
    if (this.hooks.onSelect) this.hooks.onSelect(clipId);
  }

  zoom(px, centerClientX) {
    const rect = this.wrap.getBoundingClientRect();
    const center = centerClientX !== undefined ? centerClientX - rect.left + this.wrap.scrollLeft : this.wrap.scrollLeft + rect.width / 2;
    const tAt = (center - HEADER_W) / this.pxPerSec;
    this.pxPerSec = clamp(px, 8, 400);
    this.layout();
    const newCenter = tAt * this.pxPerSec + HEADER_W;
    this.wrap.scrollLeft = Math.max(0, newCenter - (centerClientX !== undefined ? centerClientX - rect.left : rect.width / 2));
    if (this.hooks.onZoom) this.hooks.onZoom(this.pxPerSec);
  }
  fit() {
    const dur = Math.max(1, projectDuration(this.getProject()));
    this.zoom(Math.max(8, (this.wrap.clientWidth - HEADER_W - 40) / dur));
    this.wrap.scrollLeft = 0;
  }

  updatePlayhead(t) {
    this._lastT = t;
    this.playhead.style.left = (HEADER_W + t * this.pxPerSec) + 'px';
  }

  timeFromClientX(clientX) {
    const rect = this.inner.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - HEADER_W) / this.pxPerSec);
  }

  /* ---------- pointer interaction ---------- */
  onPointerDown(e) {
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 2) {
      // pinch begin
      const [a, b] = [...this._pointers.values()];
      this._pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), px: this.pxPerSec };
      this._drag = null;
      return;
    }
    const clipNode = e.target.closest('.tl-clip');
    const handle = e.target.closest('.trim-handle');
    const rulerHit = e.target.closest('.tl-ruler') || e.target.closest('.tl-ph-cap');
    const headerHit = e.target.closest('.tl-header');

    if (headerHit) {
      const row = headerHit.closest('.tl-track');
      if (row && this.hooks.onTrackHeader) this.hooks.onTrackHeader(row.dataset.trackId, e);
      return;
    }
    if (rulerHit) {
      this._scrub = true;
      try { this.wrap.setPointerCapture(e.pointerId); } catch { }
      const t = this.timeFromClientX(e.clientX);
      this.hooks.onScrub && this.hooks.onScrub(t);
      return;
    }
    if (clipNode) {
      const clipId = clipNode.dataset.clipId;
      const found = findClip(this.getProject(), clipId);
      if (!found) return;
      const now = Date.now();
      const dbl = this._lastTap && this._lastTap.id === clipId && (now - this._lastTap.ts) < 350;
      this._lastTap = { id: clipId, ts: now };
      this.select(clipId);
      if (dbl && this.hooks.onClipOpen) { this.hooks.onClipOpen(clipId); return; }
      try { this.wrap.setPointerCapture(e.pointerId); } catch { }
      if (handle) {
        this._drag = {
          mode: handle.classList.contains('left') ? 'trimL' : 'trimR',
          clipId, track: found.track, clip: found.clip,
          startX: e.clientX, orig: { ...found.clip, crop: { ...found.clip.crop }, effects: JSON.parse(JSON.stringify(found.clip.effects || [])) },
          moved: false,
        };
      } else {
        this._drag = {
          mode: 'move', clipId, track: found.track, clip: found.clip,
          startX: e.clientX, startY: e.clientY, origStart: found.clip.start, origTrackId: found.track.id,
          node: clipNode, moved: false,
        };
      }
      return;
    }
    // empty area: deselect
    if (e.target.closest('.tl-track')) this.select(null);
  }

  onPointerMove(e) {
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 2 && this._pinch) {
      const [a, b] = [...this._pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 10) {
        const cx = (a.x + b.x) / 2;
        this.zoom(this._pinch.px * (d / this._pinch.d), cx);
        this._pinch.px = this.pxPerSec;
        this._pinch.d = d;
      }
      return;
    }
    if (this._scrub) {
      const t = this.timeFromClientX(e.clientX);
      this.hooks.onScrub && this.hooks.onScrub(t);
      return;
    }
    if (!this._drag) return;
    const drag = this._drag;
    const dxT = (e.clientX - drag.startX) / this.pxPerSec;
    const p = this.getProject();
    const targets = snapTargets(p, drag.clipId);
    const tol = 9 / this.pxPerSec;

    if (!drag.moved && Math.abs(e.clientX - drag.startX) < 4 && drag.mode !== 'trimL' && drag.mode !== 'trimR') return;
    if (!drag.moved) {
      drag.moved = true;
      this.hooks.onMutateBegin && this.hooks.onMutateBegin();
      if (drag.mode === 'move') drag.node.classList.add('dragging');
    }

    if (drag.mode === 'move') {
      let ns = Math.max(0, drag.origStart + dxT);
      // snap both edges
      const dur = clipDuration(drag.clip);
      const s1 = snapTime(ns, targets, tol, p.settings.snap);
      const s2 = snapTime(ns + dur, targets, tol, p.settings.snap) - dur;
      ns = Math.abs(s1 - ns) <= Math.abs(s2 - ns) ? s1 : s2;
      ns = Math.max(0, ns);
      drag.clip.start = ns;
      drag.node.style.left = (HEADER_W + ns * this.pxPerSec) + 'px';
      // vertical track change (same kind)
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.tl-track');
      if (row) {
        const targetTrack = p.tracks.find(tr => tr.id === row.dataset.trackId);
        const compatible = targetTrack && targetTrack.kind === (drag.clip.kind === 'video' || drag.clip.kind === 'still' ? 'video' : drag.track.kind);
        const sameRow = row === drag.node.parentElement;
        if (targetTrack && compatible && !sameRow) {
          // move clip between tracks
          const from = drag.track;
          from.clips = from.clips.filter(c => c.id !== drag.clipId);
          targetTrack.clips.push(drag.clip);
          drag.track = targetTrack;
          row.append(drag.node);
        }
      }
    } else if (drag.mode === 'trimL') {
      const c = drag.clip;
      const speed = c.speed || 1;
      const orig = drag.orig;
      if (c.kind === 'video' || c.kind === 'audio') {
        let nIn = clamp(orig.in + dxT * speed, 0, orig.out - 0.1);
        let nStart = orig.start + (nIn - orig.in) / speed;
        const sn = snapTime(nStart, targets, tol, p.settings.snap);
        if (Math.abs(sn - nStart) < Math.abs(nStart - (orig.start + dxT)) || sn !== nStart) {
          const dIn = (sn - nStart) * speed;
          if (nIn + dIn >= 0 && nIn + dIn <= orig.out - 0.1) { nIn += dIn; nStart = sn; }
        }
        if (nStart >= 0) { c.in = nIn; c.start = nStart; }
      } else {
        let nStart = Math.max(0, orig.start + dxT);
        const sn = snapTime(nStart, targets, tol, p.settings.snap);
        if (sn >= 0 && Math.abs(sn - nStart) <= tol) nStart = sn;
        const nDur = orig.duration - (nStart - orig.start);
        if (nDur >= 0.1) { c.start = nStart; c.duration = nDur; }
      }
      this.refreshClipNode(c);
    } else if (drag.mode === 'trimR') {
      const c = drag.clip;
      const speed = c.speed || 1;
      const orig = drag.orig;
      if (c.kind === 'video' || c.kind === 'audio') {
        const media = mediaMap.get(c.mediaId);
        const maxOut = media ? (media.duration || orig.out) : orig.out;
        let nOut = orig.out + dxT * speed;
        nOut = clamp(nOut, c.in + 0.1, maxOut);
        c.out = nOut;
      } else {
        let nDur = orig.duration + dxT;
        c.duration = clamp(nDur, 0.1, 600);
      }
      // snap right edge
      const sn = snapTime(c.start + clipDuration(c), targets, tol, p.settings.snap);
      if (sn !== c.start + clipDuration(c)) {
        const delta = sn - (c.start + clipDuration(c));
        if (c.kind === 'video' || c.kind === 'audio') c.out = clamp(c.out + delta * (c.speed || 1), c.in + 0.1, 1e9);
        else c.duration += delta;
      }
      this.refreshClipNode(c);
    }
  }

  refreshClipNode(clip) {
    const node = this.host.querySelector(`[data-clip-id="${clip.id}"]`);
    if (!node) return;
    const d = clipDuration(clip);
    node.style.left = (HEADER_W + clip.start * this.pxPerSec) + 'px';
    node.style.width = Math.max(8, d * this.pxPerSec) + 'px';
    node.querySelector('.clip-dur').textContent = d.toFixed(1) + 's';
  }

  onPointerUp(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinch = null;
    if (this._scrub) { this._scrub = false; this.hooks.onScrubEnd && this.hooks.onScrubEnd(); }
    if (this._drag) {
      const drag = this._drag;
      if (drag.moved) {
        if (drag.mode === 'move') drag.node.classList.remove('dragging');
        this.hooks.onMutateEnd && this.hooks.onMutateEnd();
      }
      this._drag = null;
    }
  }

  scrollToTime(t) {
    const x = HEADER_W + t * this.pxPerSec;
    const rect = this.wrap.getBoundingClientRect();
    if (x < this.wrap.scrollLeft + HEADER_W + 10 || x > this.wrap.scrollLeft + rect.width - 40) {
      this.wrap.scrollLeft = Math.max(0, x - rect.width / 2);
    }
  }
}
