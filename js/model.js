/* TRALIX EDITOR — project data model, clip factories, history (undo/redo) */
import { uid, clamp, deepClone } from './util.js';

export const DEFAULT_ADJ = () => ({
  brightness: 0, contrast: 0, saturation: 0, exposure: 0,
  temperature: 0, tint: 0, highlights: 0, shadows: 0,
  sharpen: 0, fade: 0, vignette: 0, blur: 0,
});

export function newProject(opts = {}) {
  return {
    id: uid(),
    name: opts.name || 'Untitled Project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    width: opts.width || 1920,
    height: opts.height || 1080,
    fps: opts.fps || 30,
    bg: '#000000',
    tracks: [
      { id: uid(), kind: 'text', name: 'Text', muted: false, hidden: false, clips: [], transitions: {} },
      { id: uid(), kind: 'overlay', name: 'Overlays', muted: false, hidden: false, clips: [], transitions: {} },
      { id: uid(), kind: 'video', name: 'Video 1', muted: false, hidden: false, clips: [], transitions: {} },
      { id: uid(), kind: 'audio', name: 'Audio 1', muted: false, hidden: false, clips: [], transitions: {} },
      { id: uid(), kind: 'audio', name: 'Music', muted: false, hidden: false, clips: [], transitions: {} },
    ],
    markers: [], // beat markers (seconds on timeline)
    settings: { snap: true },
    version: 1,
  };
}

export function clipDuration(c) {
  switch (c.kind) {
    case 'video': case 'audio': return Math.max(0.04, (c.out - c.in) / (c.speed || 1));
    case 'still': case 'text': case 'overlay': return Math.max(0.1, c.duration);
    default: return 0;
  }
}
export function trackEnd(tr) {
  let e = 0;
  for (const c of tr.clips) e = Math.max(e, c.start + clipDuration(c));
  return e;
}
export function projectDuration(p) {
  let e = 0;
  for (const tr of p.tracks) if (!tr.hidden) e = Math.max(e, trackEnd(tr));
  return Math.max(e, 0.5);
}
export function clipsSorted(tr) { return [...tr.clips].sort((a, b) => a.start - b.start); }

export function findClip(project, clipId) {
  for (const tr of project.tracks) {
    const c = tr.clips.find(c => c.id === clipId);
    if (c) return { track: tr, clip: c };
  }
  return null;
}

export function makeVideoClip(media, start, inPoint = 0, outPoint = null) {
  const out = outPoint === null ? (media.duration || 5) : outPoint;
  return {
    id: uid(), kind: 'video', mediaId: media.id,
    start, in: inPoint, out, speed: 1,
    volume: 1, muted: false,
    rotation: 0, flipH: false, flipV: false,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    scale: 1, x: 0, y: 0,
    adj: DEFAULT_ADJ(),
    effects: [],
    fadeIn: 0, fadeOut: 0,
  };
}
export function makeAudioClip(media, start, inPoint = 0, outPoint = null) {
  const out = outPoint === null ? (media.duration || 5) : outPoint;
  return {
    id: uid(), kind: 'audio', mediaId: media.id,
    start, in: inPoint, out, speed: 1,
    volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
    fromVideo: !!media.fromVideo,
  };
}
export function makeTextClip(start, duration = 3, text = 'YOUR TEXT') {
  return {
    id: uid(), kind: 'text', start, duration,
    text,
    x: 0.5, y: 0.5,
    size: 9, // % of project height
    font: 'Rajdhani', weight: 700, italic: false,
    letterSpacing: 2, lineHeight: 1.15,
    align: 'center',
    color: '#ffffff',
    outline: { w: 0, color: '#000000' },
    shadow: { blur: 0, color: '#000000', x: 0, y: 2 },
    glow: { on: false, color: '#00e5ff', strength: 1 },
    bg: { on: false, color: '#0a0f1e', opacity: 0.72, pad: 0.35, radius: 10 },
    anim: { in: 'fade', out: 'fade', dur: 0.45, dir: 'up' },
    uppercase: false,
  };
}
export function makeOverlayClip(sub, start, duration = 4, p = {}) {
  return { id: uid(), kind: 'overlay', sub, start, duration, p: { ...p } };
}
export function makeStillClip(dataURL, start, duration = 1) {
  return {
    id: uid(), kind: 'still', src: dataURL, start, duration,
    scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    adj: DEFAULT_ADJ(), effects: [], fadeIn: 0, fadeOut: 0, volume: 0, muted: true, speed: 1,
  };
}

/* ---- clip splitting (keeps effect windows coherent) ---- */
export function splitClip(clip, cutTimelineT) {
  // cutTimelineT: absolute timeline second inside the clip
  const localT = (cutTimelineT - clip.start); // clip-local seconds (timeline speed)
  if (clip.kind === 'video' || clip.kind === 'audio') {
    const cutSrc = clip.in + localT * (clip.speed || 1);
    if (cutSrc <= clip.in + 0.05 || cutSrc >= clip.out - 0.05) return null;
    const left = deepClone(clip), right = deepClone(clip);
    left.id = uid(); right.id = uid();
    left.out = cutSrc;
    right.in = cutSrc;
    right.start = clip.start + localT;
    splitEffects(left, right, cutSrc - clip.in);
    return [left, right];
  }
  // duration based clips
  if (localT <= 0.05 || localT >= clipDuration(clip) - 0.05) return null;
  const left = deepClone(clip), right = deepClone(clip);
  left.id = uid(); right.id = uid();
  left.duration = localT;
  right.duration = clipDuration(clip) - localT;
  right.start = clip.start + localT;
  splitEffects(left, right, localT);
  return [left, right];
}

function splitEffects(left, right, cutLocal) {
  const move = [];
  left.effects = (left.effects || []).filter(fx => {
    const t0 = fx.t0 ?? 0, t1 = fx.t1 ?? Infinity;
    if (t1 <= cutLocal) return true;      // stays left
    if (t0 >= cutLocal) { move.push(fx); return false; } // moves right
    // spanning: duplicate into both, clamped
    const lfx = deepClone(fx); lfx.t1 = cutLocal; lfx.id = uid();
    const rfx = deepClone(fx); rfx.t0 = 0; rfx.id = uid();
    Object.assign(fx, { __drop: true });
    left.effects.push(lfx);
    right.effects.push(rfx);
    return false;
  });
  right.effects = [...(right.effects || []), ...move.map(fx => {
    const c = deepClone(fx);
    c.t0 = Math.max(0, (fx.t0 ?? 0) - cutLocal);
    c.t1 = fx.t1 === undefined ? undefined : fx.t1 - cutLocal;
    return c;
  })];
  left.effects = left.effects.filter(f => !f.__drop);
}

/* ---- History: JSON snapshots (small; media blobs live separately) ---- */
export class History {
  constructor(onChange) {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = onChange || (() => { });
    this.limit = 60;
  }
  reset(state) {
    this.undoStack = [JSON.stringify(state)];
    this.redoStack = [];
    this.onChange(this);
  }
  push(prevState) { // call with the state BEFORE a mutation
    this.undoStack.push(JSON.stringify(prevState));
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.onChange(this);
  }
  undo(current) {
    if (this.undoStack.length < 2) return null;
    const top = this.undoStack.pop();          // state before the last edit
    this.redoStack.push(JSON.stringify(current)); // remember current for redo
    if (this.redoStack.length > this.limit) this.redoStack.shift();
    this.onChange(this);
    return JSON.parse(top);
  }
  redo(current) {
    if (!this.redoStack.length) return null;
    const next = this.redoStack.pop();
    this.undoStack.push(next);
    this.onChange(this);
    return JSON.parse(next);
  }
  get canUndo() { return this.undoStack.length > 1; }
  get canRedo() { return this.redoStack.length > 0; }
}

/* ---- snapping helpers ---- */
export function snapTargets(project, excludeClipId = null) {
  const t = new Set([0]);
  for (const tr of project.tracks) for (const c of tr.clips) {
    if (c.id === excludeClipId) continue;
    t.add(c.start); t.add(c.start + clipDuration(c));
  }
  for (const m of project.markers) t.add(m);
  return [...t].sort((a, b) => a - b);
}
export function snapTime(t, targets, tolerance, enabled) {
  if (!enabled) return t;
  let best = t, bestD = tolerance;
  for (const x of targets) {
    const d = Math.abs(x - t);
    if (d < bestD) { bestD = d; best = x; }
  }
  return best;
}

/* ---- CODM template bundles (real data applied to clips) ---- */
export const CODM_TEMPLATES = [
  {
    id: 'sniper', name: 'Sniper Montage', icon: '🎯', desc: 'Cold grade · zoom punches · impact flashes on every cut',
    grade: { contrast: 0.18, saturation: -0.12, shadows: -0.12, temperature: -0.15, vignette: 0.35, sharpen: 0.4 },
    fx: ['zoom', 'flash', 'impact'],
    transition: { type: 'flash', dur: 0.18 },
    speedRamp: null, title: 'SNIPER MONTAGE', counter: true, slowmo: 0.5,
  },
  {
    id: 'quickscope', name: 'Quickscope', icon: '🔫', desc: 'Hard zoom-in on kills, snappy cuts, high contrast',
    grade: { contrast: 0.25, saturation: 0.05, sharpen: 0.6, shadows: -0.1 },
    fx: ['zoom', 'shake', 'rgb'],
    transition: { type: 'zoom', dur: 0.22 },
    speedRamp: [1, 2, 0.5], title: 'QUICKSCOPE', counter: true, slowmo: 0.35,
  },
  {
    id: 'shotgun', name: 'Shotgun Rush', icon: '💥', desc: 'Aggressive shake, strobe flashes, warm grit',
    grade: { contrast: 0.22, saturation: 0.12, temperature: 0.18, grainV: 0.35 },
    fx: ['shake', 'flash', 'glitch'],
    transition: { type: 'shake', dur: 0.2 },
    speedRamp: [1, 1.5, 2], title: 'RUSHED THEM ALL', counter: true, slowmo: null,
  },
  {
    id: 'mp', name: 'Multiplayer Montage', icon: '⚙️', desc: 'Beat-synced cuts with neon kill feed and XP popups',
    grade: { contrast: 0.12, saturation: 0.18, shadows: -0.08 },
    fx: ['glow', 'rgb'],
    transition: { type: 'glitch', dur: 0.25 },
    speedRamp: null, title: 'MP MONTAGE', counter: true, killfeed: true, slowmo: null,
  },
  {
    id: 'br', name: 'Battle Royale', icon: '🪂', desc: 'Cinematic teal-orange, letterbox, slow-mo finishes',
    grade: { contrast: 0.15, saturation: 0.1, temperature: -0.08, vignette: 0.3, fade: 0.05 },
    fx: ['cinematic', 'zoom'],
    transition: { type: 'dissolve', dur: 0.4 },
    speedRamp: null, title: '#1 VICTORY', counter: false, slowmo: 0.5,
  },
  {
    id: 'ranked', name: 'Ranked Clean', icon: '🏆', desc: 'Clean pro look — mild grade, subtle sharpen, no gimmicks',
    grade: { contrast: 0.08, saturation: 0.06, sharpen: 0.35 },
    fx: [],
    transition: { type: 'fade', dur: 0.25 },
    speedRamp: null, title: 'RANKED PUSH', counter: false, slowmo: null,
  },
  {
    id: 'clutch', name: 'Clutch Moment', icon: '🥶', desc: 'Slow-mo intro, desaturated build, neon 1v5 title',
    grade: { contrast: 0.2, saturation: -0.3, shadows: -0.15, vignette: 0.4 },
    fx: ['glow', 'vhs'],
    transition: { type: 'rgb', dur: 0.3 },
    speedRamp: [0.5, 1, 1.5], title: '1v5 CLUTCH', counter: true, slowmo: 0.4,
  },
];
