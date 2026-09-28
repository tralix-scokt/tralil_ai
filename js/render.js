/* TRALIX EDITOR — render engine: composites the full project frame at time t.
   The same path is used for preview and export (deterministic, seeded effects). */
import { mediaMap, getVideoEl } from './media.js';
import { FX, adjFilter, geomForClip, postAdjustments, drawTransition, scratchCanvas, ensureSvgFilters, fxProgress } from './fx.js';
import { clipDuration, clipsSorted } from './model.js';
import { clamp, rgba, easeOut, easeIn, easeBack, srand, hash } from './util.js';

ensureSvgFilters();

const layerA = document.createElement('canvas');
const layerB = document.createElement('canvas');
function lay(which, w, h) {
  const c = which === 'A' ? layerA : layerB;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.filter = 'none'; x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, w, h);
  return { c, x };
}

export function drawFrame(canvas, project, t) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = project.bg || '#000';
  ctx.fillRect(0, 0, W, H);

  for (const track of project.tracks) {
    if (track.hidden || track.kind === 'audio') continue;
    if (!track.clips.length) continue;
    if (track.kind === 'video') drawVideoTrack(ctx, project, track, t, W, H);
    else if (track.kind === 'text') drawTextTrack(ctx, project, track, t, W, H);
    else if (track.kind === 'overlay') drawOverlayTrack(ctx, project, track, t, W, H);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
}

/* ---------------- video tracks (with transitions) ---------------- */
function drawVideoTrack(ctx, project, track, t, W, H) {
  const clips = clipsSorted(track);
  let idx = -1;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (t >= c.start && t < c.start + clipDuration(c)) { idx = i; break; }
  }
  if (idx === -1) return;
  const clip = clips[idx];
  const next = clips[idx + 1];
  const boundary = clip.start + clipDuration(clip);

  // transition window?
  let trans = null;
  if (next && Math.abs(next.start - boundary) < 0.02) {
    const tr = track.transitions[clip.id];
    if (tr && tr.type !== 'none' && tr.dur > 0.01) {
      const w0 = boundary - tr.dur / 2, w1 = boundary + tr.dur / 2;
      if (t >= w0 && t < w1) trans = { tr, p: (t - w0) / tr.dur };
    }
  }

  if (trans) {
    const LA = lay('A', W, H), LB = lay('B', W, H);
    // outgoing keeps playing past its out-point (frozen at media end if needed)
    renderClipTo(LA.x, W, H, clip, t, 1, true, null, LA);
    renderClipTo(LB.x, W, H, next, t, 1, true, boundary, LB);
    drawTransition(ctx, LA.c, LB.c, trans.tr.type, clamp(trans.p, 0, 1), W, H, t);
  } else {
    renderClipTo(ctx, W, H, clip, t, 1, false);
  }
}

/* srcTExtraBase: for incoming transition clip, treat t as if clip started earlier */
function renderClipTo(ctx, W, H, clip, t, alphaMul = 1, transitionMode = false, virtualStart = null, layer = null) {
  const localT = transitionMode && virtualStart !== null ? (t - virtualStart) : (t - clip.start);
  const media = mediaMap.get(clip.mediaId);

  // geometry (zoom/shake effects)
  const geom = geomForClip(clip, localT, t, clipIdSeed(clip));
  let alpha = alphaMul * (geom.opacity ?? 1);
  if (clip.fadeIn > 0.01 && localT < clip.fadeIn) alpha *= clamp(localT / clip.fadeIn, 0, 1);
  if (clip.fadeOut > 0.01 && localT > clipDuration(clip) - clip.fadeOut) alpha *= clamp((clipDuration(clip) - localT) / clip.fadeOut, 0, 1);
  if (alpha <= 0.004) return;

  if (!media) { drawMissing(ctx, W, H, alpha); return; }

  if (clip.kind === 'still') {
    const img = stillImage(clip);
    if (!img) { drawMissing(ctx, W, H, alpha); return; }
    drawLayer(ctx, W, H, clip, localT, t, (lx, transform) => {
      lx.drawImage(img, transform.sx, transform.sy, transform.sw, transform.sh, -transform.dw / 2, -transform.dh / 2, transform.dw, transform.dh);
    }, geom, alpha, img.naturalWidth || 1280, img.naturalHeight || 720, layer);
    return;
  }

  const el = videoElSync.get(clip.id);
  if (!el || el.readyState < 2) {
    // while the decoder warms up, show the media thumbnail instead of a stark placeholder
    if (media && media.thumb) {
      drawThumbnail(ctx, W, H, media.thumb, alpha);
    } else {
      drawMissing(ctx, W, H, alpha);
    }
    return;
  }

  const vw = el.videoWidth || media.width || 1280, vh = el.videoHeight || media.height || 720;
  drawLayer(ctx, W, H, clip, localT, t, (lx, tr) => {
    try { lx.drawImage(el, tr.sx, tr.sy, tr.sw, tr.sh, -tr.dw / 2, -tr.dh / 2, tr.dw, tr.dh); } catch { /* frame not ready */ }
  }, geom, alpha, vw, vh, layer);
}

function clipIdSeed(clip) {
  let s = 0;
  for (let i = 0; i < clip.id.length; i++) s = (s * 31 + clip.id.charCodeAt(i)) | 0;
  return Math.abs(s) % 100000;
}

/* media clip entrance/exit animation -> alpha + transform deltas */
function mediaAnim(clip, localT, W, H) {
  const a = clip.anim;
  if (!a || (a.in === 'none' && a.out === 'none')) return { alpha: 1, sx: 1, dx: 0, dy: 0, rot: 0 };
  const dur = Math.max(0.12, a.dur || 0.4);
  const durT = clip.kind === 'video' || clip.kind === 'ovl' ? dur : dur; // timeline seconds
  const ai = clamp(localT / durT, 0, 1);
  const total = (clip.kind === 'video' || clip.kind === 'ovl' || clip.kind === 'still')
    ? clipDuration(clip) : (clip.duration || 1);
  const ao2 = clamp((total - localT) / durT, 0, 1);
  let alpha = 1, sx = 1, dx = 0, dy = 0, rot = 0;
  const apply = (name, p, dir) => {
    switch (name) {
      case 'fade': alpha *= easeOut(p); break;
      case 'slide':
        alpha *= easeOut(p);
        if (dir === 'in') dy += (1 - easeOut(p)) * H * 0.1;
        else dy -= (1 - easeOut(p)) * H * 0.1;
        break;
      case 'zoom': alpha *= p; sx *= 1.6 - 0.6 * easeOut(p); break;
      case 'pop': alpha *= easeOut(p); sx *= 0.5 + 0.5 * easeBack(p); break;
      case 'bounce': alpha *= easeOut(p); sx *= 1 + 0.25 * Math.sin(p * Math.PI) * (dir === 'in' ? 1 : -1); break;
      case 'spin': alpha *= easeOut(p); rot += (1 - easeOut(p)) * 0.35 * (dir === 'in' ? 1 : -1); break;
    }
  };
  if (a.in && a.in !== 'none') apply(a.in, ai, 'in');
  if (a.out && a.out !== 'none') apply(a.out, ao2, 'out');
  return { alpha, sx, dx, dy, rot };
}

/* shared draw pipeline for video/still/ovl: layer render + effects + composite */
function drawLayer(ctx, W, H, clip, localT, t, drawSrc, geom, alpha, vw = 1280, vh = 720, layer = null) {
  const L = layer || lay('A', W, H);
  const x = L.x;
  // fold clip animations into geometry/alpha
  const ma = mediaAnim(clip, localT, W, H);
  alpha *= ma.alpha;
  const animGeom = {
    scale: (geom.scale || 1) * ma.sx,
    dx: (geom.dx || 0) + ma.dx / W,
    dy: (geom.dy || 0) + ma.dy / H,
    rot: (geom.rot || 0) + ma.rot * 180 / Math.PI,
  };
  geom = animGeom;

  // crop in source pixels
  const cr = clip.crop || { l: 0, t: 0, r: 0, b: 0 };
  const sx = cr.l * vw, sy = cr.t * vh;
  const sw = Math.max(2, vw - sx - cr.r * vw), sh = Math.max(2, vh - sy - cr.b * vh);

  // rotation/flip effective dims
  const rot = ((clip.rotation || 0) + (geom.rot || 0)) * Math.PI / 180;
  if (alpha <= 0.004) { return; }
  const quarter = Math.abs(((clip.rotation || 0) % 180)) === 90;
  const ew = quarter ? sh : sw, eh = quarter ? sw : sh;

  const fit = (clip.contain ? Math.min : Math.max)(W / ew, H / eh) * (geom.scale || 1);
  const dw = ew * fit, dh = eh * fit;

  x.save();
  x.translate(W / 2 + (clip.x || 0) * W + (geom.dx || 0) * W, H / 2 + (clip.y || 0) * H + (geom.dy || 0) * H);
  x.rotate(rot);
  x.scale((clip.flipH ? -1 : 1) * 1, (clip.flipV ? -1 : 1) * 1);

  const filterBits = [adjFilter(clip.adj || {}, W)];
  const blurFx = (clip.effects || []).filter(f => f.type === 'blur' && fxProgress(f, localT) !== null);
  for (const f of blurFx) filterBits.push(`blur(${((f.p.amount * W) / 1280).toFixed(1)}px)`);
  const fstr = filterBits.filter(s => s && s !== 'none').join(' ');
  x.filter = fstr || 'none';
  drawSrc(x, { sx, sy, sw, sh, dw, dh });
  x.filter = 'none';
  x.restore();

  // post effects on layer
  const seed = clipIdSeed(clip);
  for (const fx of clip.effects || []) {
    const def = FX[fx.type];
    if (!def || !def.post || fx.type === 'blur') continue;
    const p = fxProgress(fx, localT);
    if (p === null) continue;
    try { def.post(x, W, H, fx.p || {}, p, fx.id, localT, seed); } catch (e) { console.warn('fx', fx.type, e); }
  }
  if (clip.adj) postAdjustments(x, W, H, clip.adj);

  // composite layer onto main
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.drawImage(L.c, 0, 0);
  ctx.restore();
}

/* video element sync map (filled by player) */
export const videoElSync = new Map();

const stillImgs = new Map();
function stillImage(clip) {
  let img = stillImgs.get(clip.id);
  if (img) return img.complete && img.naturalWidth ? img : null;
  img = new Image();
  img.onload = () => { }; // draw picks it up next frame
  img.src = clip.src;
  stillImgs.set(clip.id, img);
  return null;
}


const thumbCache = new Map();
function drawThumbnail(ctx, W, H, src, alpha) {
  let img = thumbCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => requestFrameRedraw();
    img.src = src;
    thumbCache.set(src, img);
    return;
  }
  if (!img.complete || !img.naturalWidth) return;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.restore();
}
let _redrawQueued = false;
function requestFrameRedraw() {
  if (_redrawQueued) return;
  _redrawQueued = true;
  requestAnimationFrame(() => {
    _redrawQueued = false;
    document.dispatchEvent(new CustomEvent('tralix-frame-ready'));
  });
}

function drawMissing(ctx, W, H, alpha) {
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  const s = Math.max(12, W / 40);
  ctx.fillStyle = '#10131c';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#1d2338'; ctx.lineWidth = Math.max(1, W / 800);
  for (let i = -H; i < W; i += s) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + H, H); ctx.stroke(); }
  ctx.fillStyle = '#4a5570';
  ctx.font = `${Math.round(H / 18)}px Rajdhani, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('MEDIA OFFLINE', W / 2, H / 2);
  ctx.restore();
}

/* ---------------- text track ---------------- */
export const FONT_STACKS = {
  'Orbitron': "'Orbitron', 'Segoe UI', sans-serif",
  'Rajdhani': "'Rajdhani', 'Segoe UI', sans-serif",
  'Bebas Neue': "'Bebas Neue', Impact, sans-serif",
  'Chakra Petch': "'Chakra Petch', 'Segoe UI', sans-serif",
  'Impact': 'Impact, Haettenschweiler, sans-serif',
  'Georgia': 'Georgia, serif',
  'Courier': '"Courier New", monospace',
  'System': '-apple-system, "Segoe UI", Roboto, sans-serif',
};

function drawTextTrack(ctx, project, track, t, W, H) {
  for (const clip of clipsSorted(track)) {
    const dur = clipDuration(clip);
    if (t < clip.start || t >= clip.start + dur) continue;
    drawTextClip(ctx, clip, t - clip.start, dur, W, H);
  }
}

export function drawTextClip(ctx, clip, localT, dur, W, H) {
  const a = clip.anim || { in: 'fade', out: 'fade', dur: 0.45, dir: 'up' };
  const ad = Math.max(0.08, a.dur || 0.45);
  const ai = clamp(localT / ad, 0, 1);          // entrance progress
  const ao = clamp((dur - localT) / ad, 0, 1);  // exit progress
  let alpha = Math.min(a.in === 'none' ? 1 : easeOut(ai), a.out === 'none' ? 1 : ao);
  if (a.in === 'none' && a.out === 'none') alpha = 1;
  let tx = 0, ty = 0, scale = 1, rot = 0;

  switch (a.in) {
    case 'slide':
      if (a.dir === 'up') ty = (1 - easeOut(ai)) * H * 0.08;
      if (a.dir === 'down') ty = -(1 - easeOut(ai)) * H * 0.08;
      if (a.dir === 'left') tx = (1 - easeOut(ai)) * W * 0.12;
      if (a.dir === 'right') tx = -(1 - easeOut(ai)) * W * 0.12;
      break;
    case 'pop': scale = 0.4 + 0.6 * easeBack(ai); break;
    case 'zoom': scale = 1.8 - 0.8 * easeOut(ai); break;
    case 'shake': {
      const j = 1 - ai;
      tx = (hash(Math.floor(localT * 40)) - 0.5) * W * 0.02 * j;
      ty = (hash(Math.floor(localT * 40) + 9) - 0.5) * W * 0.02 * j;
      break;
    }
  }
  if (a.out === 'slide') ty -= (1 - ao) * H * 0.05 * (a.dir === 'up' ? 1 : -1);
  if (a.out === 'pop' || a.out === 'zoom') scale *= 1 - (1 - ao) * 0.4;

  let text = clip.text || '';
  if (clip.uppercase) text = text.toUpperCase();
  const sizePx = (clip.size / 100) * H;
  const textOpacity = clamp(clip.opacity ?? 1, 0, 1);
  const font = `${clip.italic ? 'italic ' : ''}${clip.weight || 700} ${sizePx}px ${FONT_STACKS[clip.font] || FONT_STACKS.Rajdhani}`;
  ctx.save();
  ctx.font = font;
  ctx.textAlign = clip.align === 'left' ? 'left' : clip.align === 'right' ? 'right' : 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(clip.letterSpacing || 0) * sizePx / 24}px`;

  // typewriter
  if (a.in === 'typewriter') {
    const chars = Math.ceil(clamp(localT / (dur * 0.55), 0, 1) * text.length);
    text = text.slice(0, chars);
  }
  // glitch jitter
  if (a.in === 'glitch') {
    const g = 1 - ai;
    tx += (hash(Math.floor(localT * 50)) - 0.5) * W * 0.012 * g;
    ty += (hash(Math.floor(localT * 50) + 3) - 0.5) * W * 0.012 * g;
    rot = (hash(Math.floor(localT * 30) + 7) - 0.5) * 0.05 * g;
  }

  const lines = text.split('\n');
  const lh = sizePx * (clip.lineHeight || 1.15);
  const cx = clip.x * W + tx, cy = clip.y * H + ty;

  // measure for background
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);

  ctx.translate(cx, cy);
  if (rot) ctx.rotate(rot);
  ctx.scale(scale, scale);

  if (clip.bg && clip.bg.on) {
    const pad = sizePx * (clip.bg.pad || 0.35);
    const bw = maxW + pad * 2, bh = lh * lines.length + pad * 0.8;
    const bx = clip.align === 'left' ? -pad : clip.align === 'right' ? -bw + pad : -bw / 2;
    ctx.save();
    ctx.globalAlpha = alpha * (clip.bg.opacity ?? 0.7);
    ctx.fillStyle = clip.bg.color || '#000';
    roundRect(ctx, bx, -bh / 2, bw, bh, Math.min((clip.bg.radius || 0) * (sizePx / 24), bh / 2));
    ctx.fill();
    ctx.restore();
  }

  const drawLine = (ln, ly, rgbMode) => {
    const eAlpha = alpha * textOpacity;
    const x0 = clip.align === 'left' ? 0 : clip.align === 'right' ? 0 : 0;
    if (rgbMode) {
      ctx.save();
      ctx.globalAlpha = eAlpha * 0.8;
      ctx.fillStyle = '#ff2a2a';
      ctx.fillText(ln, -sizePx * 0.03, ly - sizePx * 0.01);
      ctx.fillStyle = '#2affff';
      ctx.fillText(ln, sizePx * 0.03, ly + sizePx * 0.01);
      ctx.restore();
    }
    if (clip.shadow && clip.shadow.blur > 0) {
      ctx.save();
      ctx.shadowColor = clip.shadow.color || '#000';
      ctx.shadowBlur = clip.shadow.blur * sizePx / 24;
      ctx.shadowOffsetX = (clip.shadow.x || 0) * sizePx / 24;
      ctx.shadowOffsetY = (clip.shadow.y || 0) * sizePx / 24;
      ctx.fillStyle = clip.color;
      ctx.globalAlpha = eAlpha;
      ctx.fillText(ln, x0, ly);
      ctx.restore();
    }
    if (clip.glow && clip.glow.on) {
      ctx.save();
      ctx.shadowColor = clip.glow.color || '#0ff';
      ctx.shadowBlur = 18 * (clip.glow.strength || 1) * sizePx / 24;
      ctx.fillStyle = clip.glow.color || '#0ff';
      ctx.globalAlpha = eAlpha * 0.9;
      ctx.fillText(ln, x0, ly); ctx.fillText(ln, x0, ly);
      ctx.restore();
    }
    if (clip.outline && clip.outline.w > 0) {
      ctx.save();
      ctx.lineWidth = clip.outline.w * sizePx / 12;
      ctx.strokeStyle = clip.outline.color || '#000';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = eAlpha;
      ctx.strokeText(ln, x0, ly);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = eAlpha;
    ctx.fillStyle = clip.color;
    ctx.fillText(ln, x0, ly);
    ctx.restore();
  };

  const glitchy = a.in === 'glitch' || (a.out === 'glitch' && ao < 1);
  const y0 = -((lines.length - 1) * lh) / 2;
  lines.forEach((ln, i) => drawLine(ln, y0 + i * lh, glitchy));

  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------------- overlay track (gaming overlays) ---------------- */
function drawOverlayTrack(ctx, project, track, t, W, H) {
  for (const clip of clipsSorted(track)) {
    const dur = clipDuration(clip);
    if (t < clip.start || t >= clip.start + dur) continue;
    if (clip.kind === 'ovl') drawMediaOverlay(ctx, clip, t, W, H);
    else drawOverlayClip(ctx, clip, t - clip.start, dur, project, W, H);
  }
}

/* image/video overlay composited above the base video */
function drawMediaOverlay(ctx, clip, t, W, H) {
  const media = mediaMap.get(clip.mediaId);
  if (!media) { drawMissing(ctx, W, H, 1); return; }
  const localT = t - clip.start;
  if (media.kind === 'video') {
    const el = videoElSync.get(clip.id);
    if (!el || el.readyState < 2) {
      if (media.thumb) drawThumbnail(ctx, W, H, media.thumb, 1);
      return;
    }
    drawLayer(ctx, W, H, clip, localT, t, (lx, tr) => {
      try { lx.drawImage(el, tr.sx, tr.sy, tr.sw, tr.sh, -tr.dw / 2, -tr.dh / 2, tr.dw, tr.dh); } catch { }
    }, geomForClip(clip, localT, t, clipIdSeed(clip)), clip.opacity ?? 1,
      el.videoWidth || media.width || 1280, el.videoHeight || media.height || 720);
  } else {
    // image overlay (photo / png / gif first frame)
    const img = ovlImage(media);
    if (!img || !img.complete || !img.naturalWidth) return;
    drawLayer(ctx, W, H, clip, localT, t, (lx, tr) => {
      lx.drawImage(img, tr.sx, tr.sy, tr.sw, tr.sh, -tr.dw / 2, -tr.dh / 2, tr.dw, tr.dh);
    }, geomForClip(clip, localT, t, clipIdSeed(clip)), clip.opacity ?? 1,
      img.naturalWidth, img.naturalHeight);
  }
}

const ovlImgCache = new Map();
function ovlImage(media) {
  let entry = ovlImgCache.get(media.id);
  if (entry) return entry;
  const img = new Image();
  entry = img;
  ovlImgCache.set(media.id, entry);
  import('./media.js').then(async m => {
    try {
      const url = await m.urlReady(media);
      img.onload = () => requestFrameRedraw();
      img.src = url;
    } catch { }
  });
  return entry;
}

export function drawOverlayClip(ctx, clip, localT, dur, project, W, H) {
  const p = clip.p || {};
  const col = p.color || '#00e5ff';
  const col2 = p.color2 || '#b388ff';
  const S = H / 720; // scale reference
  const alphaIn = clamp(localT / 0.25, 0, 1);
  const alphaOut = clamp((dur - localT) / 0.25, 0, 1);
  const alpha = Math.min(alphaIn, alphaOut);

  ctx.save();
  ctx.globalAlpha = alpha;

  switch (clip.sub) {
    case 'frame': {
      ctx.lineWidth = 3 * S;
      ctx.strokeStyle = col;
      ctx.shadowColor = col; ctx.shadowBlur = 12 * S;
      const m = 14 * S, cl = 42 * S;
      // corner accents
      const cs = [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]];
      for (const [x, y, dx, dy] of cs) {
        ctx.beginPath();
        ctx.moveTo(x, y + dy * cl); ctx.lineTo(x, y); ctx.lineTo(x + dx * cl, y);
        ctx.stroke();
      }
      break;
    }
    case 'lowerthird': {
      const h = 64 * S, y = H - h - 26 * S;
      ctx.save();
      ctx.translate(0, 0);
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(W * 0.42, y); ctx.lineTo(W * 0.40, y + h); ctx.lineTo(0, y + h);
      ctx.closePath();
      ctx.fillStyle = rgba('#0a0f1e', 0.82); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2 * S; ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(0, y, 6 * S, h);
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${26 * S}px Rajdhani, sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText((p.text || 'PLAYER').toUpperCase(), 24 * S, y + h * 0.36);
      ctx.fillStyle = col2;
      ctx.font = `600 ${17 * S}px Rajdhani, sans-serif`;
      ctx.fillText((p.sub || 'TRALIX EDITOR').toUpperCase(), 24 * S, y + h * 0.72);
      ctx.restore();
      break;
    }
    case 'rec': {
      const blink = (Math.floor(localT * 2) % 2) === 0;
      const x = W - 30 * S, y = 30 * S;
      if (blink) {
        ctx.fillStyle = '#ff3355';
        ctx.shadowColor = '#ff3355'; ctx.shadowBlur = 10 * S;
        ctx.beginPath(); ctx.arc(x, y, 9 * S, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${18 * S}px Chakra Petch, monospace`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const tc = fmtTC(localT);
      ctx.fillText('REC ' + tc, x - 16 * S, y);
      break;
    }
    case 'killfeed': {
      const msgs = (p.messages && p.messages.length ? p.messages : ['ELIMINATED', 'DOUBLE KILL', 'TRIPLE KILL', 'FURY KILL', 'RELentless']);
      const iv = Math.max(0.4, p.interval || 1.6);
      const idx = Math.floor(localT / iv) % msgs.length;
      const ph = (localT % iv) / iv;
      const pop = easeOut(clamp(ph * 6, 0, 1));
      const msg = msgs[idx].toUpperCase();
      ctx.font = `700 ${34 * S}px 'Bebas Neue', Rajdhani, sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(msg).width;
      const x = W - tw - 40 * S, y = 90 * S;
      ctx.save();
      ctx.translate(x, y); ctx.scale(pop, pop); ctx.translate(-x, -y);
      ctx.fillStyle = rgba('#0a0f1e', 0.75);
      roundRect(ctx, x - 14 * S, y - 24 * S, tw + 28 * S, 48 * S, 8 * S);
      ctx.fill();
      ctx.strokeStyle = '#ff3355'; ctx.lineWidth = 2 * S; ctx.stroke();
      ctx.fillStyle = '#ff5577';
      ctx.shadowColor = '#ff3355'; ctx.shadowBlur = 10 * S;
      ctx.fillText(msg, x, y);
      ctx.restore();
      break;
    }
    case 'xp': {
      const iv = Math.max(0.5, p.interval || 1.2);
      const ph = (localT % iv) / iv;
      const txt = p.text || '+100 XP';
      const rise = easeOut(ph) * 40 * S;
      const fade = 1 - clamp((ph - 0.6) / 0.4, 0, 1);
      ctx.font = `700 ${30 * S}px Rajdhani, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.save();
      ctx.globalAlpha = alpha * fade;
      ctx.fillStyle = '#ffe14d';
      ctx.shadowColor = '#ffb300'; ctx.shadowBlur = 12 * S;
      ctx.fillText(txt, W * 0.72, H * 0.28 - rise);
      ctx.restore();
      break;
    }
    case 'counter': {
      // kill counter — counts beat markers passed within the clip window
      const per = Math.max(1, p.per || 1);
      let count = p.start ?? 0;
      for (const m of project.markers) if (m >= clip.start && m <= clip.start + localT) count++;
      count = Math.floor(count / per);
      const n = String(count).padStart(2, '0');
      const txt = `${(p.prefix || 'KILLS').toUpperCase()} ${n}`;
      const jitter = (hash(Math.floor(localT * 12)) - 0.5) * 2 * S;
      ctx.font = `700 ${44 * S}px 'Orbitron', Rajdhani, sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.save();
      ctx.translate(W - 34 * S, H - 60 * S + jitter);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = rgba('#0a0f1e', 0.7);
      const tw = ctx.measureText(txt).width;
      roundRect(ctx, -tw - 18 * S, -30 * S, tw + 18 * S, 60 * S, 10 * S); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.shadowColor = col; ctx.shadowBlur = 14 * S;
      ctx.textAlign = 'right';
      ctx.fillText(txt, -18 * S, 0);
      ctx.restore();
      break;
    }
    case 'vs': {
      const ph = clamp(localT / 0.5, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, H / 2 - 30 * S * ph, W, 60 * S * ph);
      ctx.fillStyle = col; ctx.fillRect(0, H / 2 - 34 * S * ph, W, 3 * S);
      ctx.fillStyle = col2; ctx.fillRect(0, H / 2 + 31 * S * ph, W, 3 * S);
      if (ph > 0.7) {
        ctx.font = `700 ${48 * S}px 'Orbitron', sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.globalAlpha = alpha * clamp((ph - 0.7) / 0.3, 0, 1);
        ctx.shadowColor = col; ctx.shadowBlur = 16 * S;
        ctx.fillStyle = '#fff';
        ctx.fillText(p.text || 'VS', W / 2, H / 2);
      }
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}

function fmtTC(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
