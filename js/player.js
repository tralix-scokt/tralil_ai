/* TRALIX EDITOR — playback controller: master clock, video element sync, draw loop */
import { audioEngine } from './audio.js';
import { drawFrame, videoElSync } from './render.js';
import { mediaMap, getVideoEl, dropVideoEl, audioCtx } from './media.js';
import { clipDuration, clipsSorted, projectDuration } from './model.js';
import { clamp } from './util.js';

export class Player {
  constructor(getProject, canvas) {
    this.getProject = getProject;
    this.canvas = canvas;
    this._frameReady = () => this.requestDraw();
    document.addEventListener('tralix-frame-ready', this._frameReady);
    this.playing = false;
    this.t = 0;
    this.fromT = 0;
    this.anchorCtx = 0;
    this.loop = false;
    this.muted = false;
    this._raf = null;
    this._drawQueued = false;
    this._pendingEls = new Set();
    this.onFrame = null;   // (t, playing)
    this.onEnd = null;     // ()
    this._seekBound = new WeakSet();
  }

  duration() { return projectDuration(this.getProject()); }

  bind(canvas) { this.canvas = canvas; this.requestDraw(); }

  async play(fromT) {
    const p = this.getProject();
    if (!p) return;
    const dur = this.duration();
    let start = fromT ?? this.t;
    if (start >= dur - 0.05) start = 0;
    const actx = audioCtx();
    if (actx.state === 'suspended') await actx.resume().catch(() => { });
    this.playing = true;
    this.fromT = start;
    this.anchorCtx = actx.currentTime + 0.08;
    audioEngine.setSpeakerMuted(this.muted);
    audioEngine.schedule(p, start, this.anchorCtx);
    this.t = start;
    this._loop();
  }

  pause() {
    this.playing = false;
    audioEngine.stopAll();
    for (const el of videoElSync.values()) { try { el.pause(); } catch { } }
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this.syncVideoEls(this.t);
    this.requestDraw();
    if (this.onFrame) this.onFrame(this.t, false);
  }

  toggle() { if (this.playing) this.pause(); else this.play(); return this.playing; }

  seek(t, opts = {}) {
    const p = this.getProject();
    this.t = clamp(t, 0, Math.max(0.001, this.duration()));
    if (this.playing) {
      audioEngine.schedule(p, this.t); // reschedule from new position
      this.fromT = this.t;
      this.anchorCtx = audioCtx().currentTime + 0.05;
    }
    this.syncVideoEls(this.t);
    this.requestDraw();
    if (!opts.silent && this.onFrame) this.onFrame(this.t, this.playing);
  }

  step(frames = 1) {
    const p = this.getProject();
    const dt = frames / (p.fps || 30);
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.seek(this.t + dt);
  }

  setLoop(v) { this.loop = v; }
  setMuted(v) { this.muted = v; audioEngine.setSpeakerMuted(v || !this.playing ? v : false); if (this.playing) audioEngine.setSpeakerMuted(v); }

  _loop = () => {
    if (!this.playing) return;
    const actx = audioCtx();
    const t = this.fromT + (actx.currentTime - this.anchorCtx);
    const dur = this.duration();
    if (t >= dur) {
      if (this.loop) { this.play(0); if (this.onFrame) this.onFrame(this.t, true); return; }
      this.t = dur;
      this.pause();
      if (this.onFrame) this.onFrame(this.t, false);
      if (this.onEnd) this.onEnd();
      return;
    }
    this.t = t;
    this.syncVideoEls(t);
    this.draw(t);
    if (this.onFrame) this.onFrame(t, true);
    this._raf = requestAnimationFrame(this._loop);
  };

  /* keep every clip's <video> element on the right source frame */
  syncVideoEls(t, collect = null) {
    const p = this.getProject();
    if (!p) return;
    const wanted = new Map(); // clipId -> {clip, media, desired}
    for (const track of p.tracks) {
      if (track.kind !== 'video' || track.hidden) continue;
      const clips = clipsSorted(track);
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        const d = clipDuration(c);
        const start = c.start, end = c.start + d;
        const media = mediaMap.get(c.mediaId);
        if (!media) continue;
        // active normally, or during a transition window touching this boundary
        const tr = track.transitions[c.id];
        const nb = clips[i + 1];
        let near = t >= start - 0.01 && t < end + 0.01;
        if (!near && tr && tr.type !== 'none' && nb && Math.abs(nb.start - end) < 0.02) {
          const w = tr.dur / 2;
          if ((t >= end - w && t <= end + w)) near = true;
        }
        if (!near) continue;
        const speed = clamp(c.speed || 1, 0.07, 16);
        const raw = c.in + (t - start) * speed;
        const desired = clamp(raw, 0, Math.max(0.05, (media.duration || raw)));
        wanted.set(c.id, { clip: c, media, desired, active: t >= start && t < end });
      }
    }
    // pause elements no longer wanted
    for (const [clipId, el] of videoElSync) {
      if (!wanted.has(clipId)) { try { if (!el.paused) el.pause(); } catch { } }
    }
    for (const [clipId, info] of wanted) {
      let el = videoElSync.get(clipId);
      if (!el) {
        if (this._pendingEls.has(clipId)) continue;
        this._pendingEls.add(clipId);
        getVideoEl(info.clip, info.media).then(e => {
          this._pendingEls.delete(clipId);
          if (!this._seekBound.has(e)) {
            this._seekBound.add(e);
            e.addEventListener('seeked', () => { if (!this.playing) this.requestDraw(); });
            e.addEventListener('loadeddata', () => this.requestDraw());
          }
          videoElSync.set(clipId, e);
          e.currentTime = info.desired;
          this.requestDraw();
        }).catch(() => this._pendingEls.delete(clipId));
        continue;
      }
      const speed = clamp(info.clip.speed || 1, 0.07, 16);
      try { if (el.playbackRate !== speed) el.playbackRate = speed; } catch { }
      const drift = Math.abs(el.currentTime - info.desired);
      if (this.playing && info.active) {
        if (drift > 0.14 && !el.seeking) { try { el.currentTime = info.desired; } catch { } }
        if (el.paused) el.play().catch(() => { });
      } else {
        if (!el.paused) el.pause();
        if (drift > 0.03 && !el.seeking) { try { el.currentTime = info.desired; } catch { } }
      }
    }
  }

  /* ensure elements for current frame exist before first paint */
  async prepare() {
    this.syncVideoEls(this.t);
    if (this._pendingEls.size) {
      await new Promise(r => {
        const iv = setInterval(() => { if (!this._pendingEls.size) { clearInterval(iv); r(); } }, 50);
        setTimeout(() => { clearInterval(iv); r(); }, 4000);
      });
    }
  }

  requestDraw() {
    if (this._drawQueued || this.playing) return;
    this._drawQueued = true;
    requestAnimationFrame(() => {
      this._drawQueued = false;
      this.draw(this.t);
      if (this.onFrame) this.onFrame(this.t, false);
    });
  }

  draw(t) {
    if (!this.canvas) return;
    const p = this.getProject();
    if (!p) return;
    try { drawFrame(this.canvas, p, t); } catch (e) { console.warn('draw error', e); }
  }

  /* drop elements for removed clips */
  static releaseClip(clipId) { dropVideoEl(clipId); videoElSync.delete(clipId); }
}
