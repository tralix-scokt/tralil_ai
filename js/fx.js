/* TRALIX EDITOR — FX engine: adjustments, effect registry, SVG filter helpers,
   grade presets, transition renderers. All deterministic (preview == export). */
import { clamp, rgba, srand, noise1, easeOut, easeIn, easeInOut, easeBack } from './util.js';

/* ---------------- SVG filter helpers (channel isolation, convolution) ---------------- */
let svgReady = false;
export function ensureSvgFilters() {
  if (svgReady) return;
  svgReady = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  const mk = (id, inner) => {
    const f = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    f.setAttribute('id', id);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.innerHTML = inner;
    svg.appendChild(f);
  };
  mk('tx-r', '<feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/>');
  mk('tx-g', '<feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"/>');
  mk('tx-b', '<feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"/>');
  mk('tx-sharp', '<feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0"/>');
  document.body.appendChild(svg);
}
export function svgFilterWorks() {
  ensureSvgFilters();
  if (svgFilterWorks._t !== undefined) return svgFilterWorks._t;
  // probe: url() filters are unsupported in Safari's ctx.filter
  const c = document.createElement('canvas'); c.width = c.height = 4;
  const ctx = c.getContext('2d');
  ctx.filter = 'url(#tx-r)';
  svgFilterWorks._t = ctx.filter !== 'none';
  return svgFilterWorks._t;
}

/* ---------------- adjustments -> canvas filter string ---------------- */
export function adjFilter(adj, W) {
  const f = [];
  const bright = 1 + (adj.brightness || 0) * 0.75 + (adj.exposure || 0) * 0.55;
  if (Math.abs(bright - 1) > 0.001) f.push(`brightness(${clamp(bright, 0, 3).toFixed(3)})`);
  if (adj.contrast) f.push(`contrast(${clamp(1 + adj.contrast, 0, 4).toFixed(3)})`);
  if (adj.saturation) f.push(`saturate(${clamp(1 + adj.saturation, 0, 4).toFixed(3)})`);
  if (adj.blur) f.push(`blur(${((adj.blur * W) / 1280).toFixed(2)}px)`);
  return f.length ? f.join(' ') : 'none';
}

/* geometry-stage contributions from adjustments/effects (zoom/shake before draw) */
export function geomForClip(clip, localT, t, seedBase) {
  let scale = clip.scale || 1, dx = 0, dy = 0, rot = 0, opacity = 1;
  for (const fx of clip.effects || []) {
    const def = FX[fx.type];
    if (!def || !def.geom) continue;
    const p = fxProgress(fx, localT);
    if (p === null) continue;
    const g = def.geom(fx.p || {}, p, localT, seedBase + fx.id);
    scale *= g.scale || 1; dx += g.dx || 0; dy += g.dy || 0; rot += g.rot || 0;
    if (g.opacity !== undefined) opacity *= g.opacity;
  }
  return { scale, dx, dy, rot, opacity };
}
export function fxProgress(fx, localT) {
  const t0 = fx.t0 ?? 0, t1 = fx.t1;
  if (t1 !== undefined && t1 !== null && (localT < t0 || localT > t1)) return null;
  if (t1 !== undefined && t1 !== null && t1 > t0) return clamp((localT - t0) / (t1 - t0), 0, 1);
  return 1; // whole-clip effect
}
/* pulse envelope for impact-style effects */
export function pulse(prog, hold = 0.12, decay = 7) {
  return prog < hold ? prog / hold : Math.exp(-(prog - hold) * decay);
}

/* ---------------- post-stage overlay: adjustments that can't be a filter ---------------- */
export function postAdjustments(ctx, W, H, adj) {
  if (adj.fade) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighten';
    ctx.globalAlpha = clamp(adj.fade * 0.5, 0, 1);
    ctx.fillStyle = '#8a8a8a';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = clamp(adj.fade * 0.35, 0, 1);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (adj.temperature) {
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = clamp(Math.abs(adj.temperature), 0, 1);
    ctx.fillStyle = adj.temperature > 0 ? '#ff9a3c' : '#3ca0ff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (adj.tint) {
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = clamp(Math.abs(adj.tint), 0, 1);
    ctx.fillStyle = adj.tint > 0 ? '#ff3cf0' : '#3cff8f';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  if (adj.highlights || adj.shadows) {
    ctx.save();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    if (adj.highlights > 0) { g.addColorStop(0, rgba('#ffffff', clamp(adj.highlights * 0.4, 0, 1))); g.addColorStop(0.5, 'rgba(255,255,255,0)'); }
    else { g.addColorStop(0, rgba('#0a1020', clamp(-adj.highlights * 0.45, 0, 1))); g.addColorStop(0.5, 'rgba(0,0,0,0)'); }
    ctx.fillStyle = g; ctx.globalCompositeOperation = 'soft-light';
    ctx.fillRect(0, 0, W, H);
    if (adj.shadows !== 0) {
      const g2 = ctx.createLinearGradient(0, H, 0, 0);
      if (adj.shadows < 0) { g2.addColorStop(0, rgba('#05080f', clamp(-adj.shadows * 0.5, 0, 1))); g2.addColorStop(0.6, 'rgba(0,0,0,0)'); }
      else { g2.addColorStop(0, rgba('#4a5570', clamp(adj.shadows * 0.35, 0, 1))); g2.addColorStop(0.6, 'rgba(0,0,0,0)'); }
      ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }
  if (adj.vignette) {
    ctx.save();
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${clamp(adj.vignette, 0, 1).toFixed(3)})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

/* ---------------- scratch canvases ---------------- */
const scratch = {};
export function scratchCanvas(key, w, h) {
  let s = scratch[key];
  if (!s) { s = scratch[key] = { c: document.createElement('canvas'), x: null }; }
  if (s.c.width !== w || s.c.height !== h) { s.c.width = w; s.c.height = h; }
  s.x = s.c.getContext('2d');
  s.x.setTransform(1, 0, 0, 1, 0, 0);
  s.x.globalAlpha = 1; s.x.globalCompositeOperation = 'source-over'; s.x.filter = 'none';
  return s;
}

/* ---------------- effect registry ---------------- */
export const FX = {
  blur: {
    name: 'Blur', icon: '🌫️', cat: 'look',
    p: { amount: { label: 'Amount', min: 0, max: 24, def: 8, step: 0.5 } },
    post(ctx, W, H, p) { /* handled via base filter for perf */ },
  },
  mblur: {
    name: 'Motion Blur', icon: '💫', cat: 'look',
    p: { amount: { label: 'Strength', min: 0.05, max: 0.8, def: 0.35, step: 0.05 } },
    post(ctx, W, H, p, env, key) {
      // temporal blur: blend with cached previous frame of this layer
      const store = scratch['mb:' + key];
      if (store && store.c.width === W) {
        ctx.save(); ctx.globalAlpha = clamp(p.amount, 0, 0.9);
        ctx.drawImage(store.c, 0, 0); ctx.restore();
      }
      if (!store || store.c.width !== W) { const s = scratchCanvas('mb:' + key, W, H); s.x.drawImage(ctx.canvas, 0, 0); }
      else { const s = scratchCanvas('mb:' + key, W, H); s.x.clearRect(0, 0, W, H); s.x.drawImage(ctx.canvas, 0, 0); }
    },
  },
  glow: {
    name: 'Glow', icon: '✨', cat: 'look',
    p: { amount: { label: 'Intensity', min: 0.1, max: 1, def: 0.45, step: 0.05 } },
    post(ctx, W, H, p) {
      const s = scratchCanvas('glow', W, H);
      s.x.clearRect(0, 0, W, H);
      s.x.filter = `blur(${Math.round(W / 90)}px) brightness(1.35)`;
      s.x.drawImage(ctx.canvas, 0, 0);
      s.x.filter = 'none';
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = clamp(p.amount, 0, 1);
      ctx.drawImage(s.c, 0, 0); ctx.restore();
    },
  },
  sharpen: {
    name: 'Sharpen', icon: '🔪', cat: 'look',
    p: { amount: { label: 'Amount', min: 0.1, max: 1, def: 0.5, step: 0.05 } },
    post(ctx, W, H, p) {
      if (svgFilterWorks()) {
        const s = scratchCanvas('sharp', W, H);
        s.x.clearRect(0, 0, W, H);
        s.x.filter = 'url(#tx-sharp)';
        s.x.drawImage(ctx.canvas, 0, 0);
        s.x.filter = 'none';
        ctx.save(); ctx.globalAlpha = clamp(p.amount, 0, 1);
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(s.c, 0, 0); ctx.restore();
      } else {
        ctx.save(); ctx.filter = 'contrast(1.12) saturate(1.03)'; ctx.globalAlpha = p.amount * 0.6;
        ctx.drawImage(ctx.canvas, 0, 0); ctx.restore();
      }
    },
  },
  vignette: {
    name: 'Vignette', icon: '⭕', cat: 'look',
    p: { amount: { label: 'Amount', min: 0.1, max: 1, def: 0.45, step: 0.05 } },
    post(ctx, W, H, p) { postAdjustments(ctx, W, H, { vignette: p.amount }); },
  },
  grain: {
    name: 'Grain', icon: '🎞️', cat: 'look',
    p: { amount: { label: 'Amount', min: 0.05, max: 0.6, def: 0.2, step: 0.05 } },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const n = Math.floor(tSec * 24);
      const tile = noiseTile(n);
      ctx.save(); ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = clamp(p.amount, 0, 1);
      const pat = ctx.createPattern(tile, 'repeat');
      ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    },
  },
  glitch: {
    name: 'Glitch', icon: '📺', cat: 'fx',
    p: {
      intensity: { label: 'Intensity', min: 0.1, max: 1, def: 0.5, step: 0.05 },
      speed: { label: 'Speed', min: 1, max: 20, def: 8, step: 1 },
    },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const rnd = srand(Math.floor(tSec * p.speed * 60) + seed * 977);
      const slices = 3 + Math.floor(rnd() * 6);
      const s = scratchCanvas('glitch', W, H);
      s.x.clearRect(0, 0, W, H); s.x.drawImage(ctx.canvas, 0, 0);
      ctx.save();
      for (let i = 0; i < slices; i++) {
        const sy = rnd() * H, sh = (0.02 + rnd() * 0.08) * H;
        const off = (rnd() - 0.5) * W * 0.12 * p.intensity;
        ctx.clearRect(0, sy, W, sh);
        ctx.drawImage(s.c, 0, sy, W, sh, off, sy, W, sh);
      }
      ctx.restore();
      rgbPass(ctx, W, H, 3 + p.intensity * 10, 0.5, tSec, seed);
    },
  },
  rgb: {
    name: 'RGB Split', icon: '🌈', cat: 'fx',
    p: {
      amount: { label: 'Offset', min: 1, max: 40, def: 10, step: 1 },
      angle: { label: 'Angle', min: 0, max: 360, def: 0, step: 15 },
    },
    post(ctx, W, H, p, env, key, tSec, seed) { rgbPass(ctx, W, H, p.amount * (W / 1280), 1, tSec, seed, p.angle); },
  },
  chroma: {
    name: 'Chromatic Aberration', icon: '💎', cat: 'fx',
    p: { amount: { label: 'Amount', min: 1, max: 24, def: 5, step: 1 } },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const a = p.amount * (W / 1280);
      const s = scratchCanvas('chroma', W, H);
      s.x.clearRect(0, 0, W, H); s.x.drawImage(ctx.canvas, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.85;
      if (svgFilterWorks()) {
        ctx.filter = 'url(#tx-r)';
        ctx.drawImage(s.c, -a, -a * 0.4);
        ctx.filter = 'url(#tx-b)';
        ctx.drawImage(s.c, a, a * 0.4);
      } else {
        ctx.filter = 'hue-rotate(120deg) saturate(2)';
        ctx.globalAlpha = 0.25; ctx.drawImage(s.c, -a, 0);
        ctx.filter = 'hue-rotate(-120deg) saturate(2)';
        ctx.drawImage(s.c, a, 0);
      }
      ctx.restore();
    },
  },
  shake: {
    name: 'Screen Shake', icon: '📳', cat: 'fx',
    p: {
      intensity: { label: 'Intensity', min: 0.05, max: 1, def: 0.4, step: 0.05 },
      speed: { label: 'Speed', min: 5, max: 40, def: 22, step: 1 },
    },
    geom(p, prog, localT, seed) {
      const t = localT * p.speed;
      const a = p.intensity * 0.05;
      return {
        dx: (noise1(t, seed) - 0.5) * 2 * a,
        dy: (noise1(t + 99, seed) - 0.5) * 2 * a,
        rot: (noise1(t + 55, seed) - 0.5) * 0.03 * p.intensity,
      };
    },
  },
  zoom: {
    name: 'Zoom Punch', icon: '🔍', cat: 'fx',
    p: {
      amount: { label: 'Punch', min: 0.02, max: 0.5, def: 0.12, step: 0.01 },
      rate: { label: 'Rate (per sec)', min: 0.2, max: 4, def: 1, step: 0.1 },
    },
    geom(p, prog, localT) {
      const phase = (localT * p.rate) % 1;
      const e = pulse(phase);
      return { scale: 1 + p.amount * e };
    },
  },
  flash: {
    name: 'Flash', icon: '⚡', cat: 'fx',
    p: {
      amount: { label: 'Brightness', min: 0.1, max: 1, def: 0.6, step: 0.05 },
      rate: { label: 'Rate (per sec)', min: 0.2, max: 6, def: 1, step: 0.1 },
      color: { label: 'Color', type: 'color', def: '#ffffff' },
    },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const phase = (tSec * p.rate) % 1;
      const a = p.amount * pulse(phase, 0.08, 9);
      if (a <= 0.01) return;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(p.color || '#ffffff', clamp(a, 0, 1));
      ctx.fillRect(0, 0, W, H); ctx.restore();
    },
  },
  distortion: {
    name: 'Distortion', icon: '🌀', cat: 'fx',
    p: { amount: { label: 'Amount', min: 0.05, max: 1, def: 0.3, step: 0.05 } },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const strips = 18;
      const s = scratchCanvas('dist', W, H);
      s.x.clearRect(0, 0, W, H); s.x.drawImage(ctx.canvas, 0, 0);
      ctx.save(); ctx.clearRect(0, 0, W, H);
      const sh = H / strips;
      for (let i = 0; i < strips; i++) {
        const off = Math.sin(tSec * 6 + i * 0.7) * W * 0.03 * p.amount * (noise1(i * 3.1 + tSec, seed));
        ctx.drawImage(s.c, 0, i * sh, W, sh + 1, off, i * sh, W, sh + 1);
      }
      ctx.restore();
    },
  },
  vhs: {
    name: 'VHS', icon: '📼', cat: 'look',
    p: { amount: { label: 'Amount', min: 0.1, max: 1, def: 0.5, step: 0.05 } },
    post(ctx, W, H, p, env, key, tSec, seed) {
      rgbPass(ctx, W, H, 2 + p.amount * 5, 0.6, tSec, seed);
      // scanlines
      ctx.save(); ctx.globalAlpha = 0.12 * p.amount; ctx.fillStyle = '#000';
      const step = Math.max(2, Math.round(H / 240));
      for (let y = (Math.floor(tSec * 60) % (step * 2)); y < H; y += step * 2) ctx.fillRect(0, y, W, step);
      ctx.restore();
      // tracking band
      const bandY = ((tSec * 0.35) % 1) * H;
      const g = ctx.createLinearGradient(0, bandY - H * 0.1, 0, bandY + H * 0.1);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${0.08 * p.amount})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, bandY - H * 0.1, W, H * 0.2); ctx.restore();
      // jitter
      if (hash(tSec * 7) > 0.93) {
        ctx.save(); ctx.globalAlpha = 0.25; ctx.drawImage(ctx.canvas, (hash(tSec * 13) - 0.5) * 20 * p.amount, 2); ctx.restore();
      }
    },
  },
  film: {
    name: 'Film', icon: '🎥', cat: 'look',
    p: { amount: { label: 'Amount', min: 0.1, max: 1, def: 0.5, step: 0.05 } },
    post(ctx, W, H, p, env, key, tSec, seed) {
      ctx.save(); ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = 0.25 * p.amount; ctx.fillStyle = '#c9a36a'; ctx.fillRect(0, 0, W, H); ctx.restore();
      const flick = 0.96 + noise1(tSec * 24, seed) * 0.08;
      ctx.save(); ctx.globalAlpha = (1 - flick) * p.amount; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); ctx.restore();
      FX.grain.post(ctx, W, H, { amount: 0.14 * p.amount }, env, key, tSec, seed);
      postAdjustments(ctx, W, H, { vignette: 0.3 * p.amount });
    },
  },
  cinematic: {
    name: 'Cinematic', icon: '🎬', cat: 'look',
    p: {
      bars: { label: 'Bars', min: 0, max: 0.2, def: 0.11, step: 0.01 },
      warmth: { label: 'Teal/Orange', min: 0, max: 1, def: 0.6, step: 0.05 },
    },
    post(ctx, W, H, p) {
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = 0.35 * p.warmth;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#ff9a3c'); g.addColorStop(0.5, '#888888'); g.addColorStop(1, '#2a7fbf');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.restore();
      postAdjustments(ctx, W, H, { vignette: 0.25 });
      if (p.bars > 0.005) {
        ctx.save(); ctx.fillStyle = '#000';
        const bh = H * p.bars;
        ctx.fillRect(0, 0, W, bh); ctx.fillRect(0, H - bh, W, bh);
        ctx.restore();
      }
    },
  },
  impact: {
    name: 'Impact FX', icon: '💥', cat: 'fx',
    p: {
      rate: { label: 'Hits / sec', min: 0.25, max: 4, def: 1, step: 0.25 },
      power: { label: 'Power', min: 0.1, max: 1, def: 0.6, step: 0.05 },
    },
    geom(p, prog, localT, seed) {
      const phase = (localT * p.rate) % 1;
      const e = pulse(phase, 0.1, 8) * p.power;
      return {
        scale: 1 + 0.16 * e,
        dx: (noise1(localT * 60, seed) - 0.5) * 0.06 * e,
        dy: (noise1(localT * 60 + 7, seed) - 0.5) * 0.06 * e,
        rot: (noise1(localT * 60 + 13, seed) - 0.5) * 0.05 * e,
      };
    },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const phase = (tSec * p.rate) % 1;
      const e = pulse(phase, 0.1, 8) * p.power;
      if (e > 0.03) {
        rgbPass(ctx, W, H, 6 * e * (W / 1280), 0.8, tSec, seed);
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = rgba('#ffffff', 0.16 * e); ctx.fillRect(0, 0, W, H); ctx.restore();
      }
    },
  },

  /* ---- TRALIX FX library additions (v2) ---- */
  killflash: {
    name: 'Kill Flash', icon: '☠️', cat: 'gaming',
    p: {
      intensity: { label: 'Intensity', min: 0.2, max: 1, def: 0.85, step: 0.05 },
      rate: { label: 'Hits / sec', min: 0.25, max: 6, def: 1, step: 0.25 },
      color: { label: 'Color', type: 'color', def: '#ffffff' },
    },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const phase = (tSec * p.rate) % 1;
      const e = pulse(phase, 0.06, 13) * p.intensity;
      if (e <= 0.02) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = rgba(p.color || '#ffffff', clamp(e, 0, 1));
      ctx.fillRect(0, 0, W, H);
      // red sting at the tail of the flash
      const e2 = Math.max(0, e - 0.55) * 1.8;
      if (e2 > 0.02) {
        ctx.fillStyle = rgba('#ff2444', clamp(e2 * 0.5, 0, 1));
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
    },
  },
  scope: {
    name: 'Scope Zoom', icon: '🎯', cat: 'gaming',
    p: {
      amount: { label: 'Zoom', min: 0.05, max: 0.6, def: 0.22, step: 0.01 },
      rate: { label: 'Rate (per sec)', min: 0.2, max: 3, def: 0.9, step: 0.1 },
    },
    geom(p, prog, localT) {
      const phase = (localT * p.rate) % 1;
      const e = pulse(phase, 0.22, 4.5);
      return { scale: 1 + p.amount * e };
    },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const phase = (tSec * p.rate) % 1;
      const e = pulse(phase, 0.22, 4.5);
      if (e < 0.05) return;
      const r = Math.min(W, H) * (0.62 - 0.12 * e);
      ctx.save();
      // darken outside the scope circle
      ctx.fillStyle = `rgba(0,0,0,${(0.75 * e).toFixed(3)})`;
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2, true);
      ctx.fill();
      // crosshair
      ctx.strokeStyle = `rgba(255,255,255,${(0.55 * e).toFixed(3)})`;
      ctx.lineWidth = Math.max(1.5, W / 900);
      ctx.beginPath();
      ctx.moveTo(W / 2 - r, H / 2); ctx.lineTo(W / 2 + r, H / 2);
      ctx.moveTo(W / 2, H / 2 - r); ctx.lineTo(W / 2, H / 2 + r);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    },
  },
  hitzoom: {
    name: 'Hit Zoom', icon: '💥', cat: 'gaming',
    p: {
      amount: { label: 'Punch', min: 0.05, max: 0.5, def: 0.2, step: 0.01 },
      rate: { label: 'Hits / sec', min: 0.25, max: 4, def: 1, step: 0.25 },
      twist: { label: 'Twist', min: 0, max: 1, def: 0.3, step: 0.05 },
    },
    geom(p, prog, localT, seed) {
      const phase = (localT * p.rate) % 1;
      const e = pulse(phase, 0.08, 10);
      return {
        scale: 1 + p.amount * e,
        rot: (noise1(localT * 90 + 31, seed) - 0.5) * 0.06 * p.twist * e,
        dx: (noise1(localT * 90, seed) - 0.5) * 0.02 * e,
      };
    },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const phase = (tSec * p.rate) % 1;
      const e = pulse(phase, 0.08, 10);
      if (e > 0.04) rgbPass(ctx, W, H, 4 * e * (W / 1280), 0.5, tSec, seed);
    },
  },
  velocity: {
    name: 'Velocity', icon: '💨', cat: 'gaming',
    p: {
      amount: { label: 'Streaks', min: 0.05, max: 1, def: 0.4, step: 0.05 },
      angle: { label: 'Angle', min: 0, max: 360, def: 0, step: 15 },
    },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const a = clamp(p.amount, 0, 1);
      const rad = (p.angle * Math.PI) / 180;
      const dx = Math.cos(rad), dy = Math.sin(rad);
      const s = scratchCanvas('vel', W, H);
      s.x.clearRect(0, 0, W, H); s.x.drawImage(ctx.canvas, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i <= 5; i++) {
        ctx.globalAlpha = 0.16 * a * (1 - i / 6);
        const off = i * W * 0.014 * a;
        ctx.drawImage(s.c, dx * off, dy * off);
        ctx.drawImage(s.c, -dx * off, -dy * off);
      }
      ctx.restore();
    },
  },
  distblock: {
    name: 'Digital Distortion', icon: '🧩', cat: 'gaming',
    p: {
      intensity: { label: 'Intensity', min: 0.05, max: 1, def: 0.45, step: 0.05 },
      speed: { label: 'Speed', min: 1, max: 24, def: 10, step: 1 },
    },
    post(ctx, W, H, p, env, key, tSec, seed) {
      const rnd = srand(Math.floor(tSec * p.speed * 24) + seed * 131);
      const s = scratchCanvas('distblock', W, H);
      s.x.clearRect(0, 0, W, H); s.x.drawImage(ctx.canvas, 0, 0);
      const blocks = 5 + Math.floor(rnd() * 9);
      const px = Math.max(2, Math.round(W / 90));
      ctx.save();
      for (let i = 0; i < blocks; i++) {
        const bx = rnd() * W, by = rnd() * H;
        const bw = (0.05 + rnd() * 0.2) * W, bh = (0.02 + rnd() * 0.08) * H;
        const ox = (rnd() - 0.5) * W * 0.1 * p.intensity;
        // pixelated block copy
        const tw = Math.max(2, Math.round(bw / px)), th = Math.max(2, Math.round(bh / px));
        const t = scratchCanvas('distblockT', tw, th);
        t.x.imageSmoothingEnabled = true;
        t.x.clearRect(0, 0, tw, th);
        t.x.drawImage(s.c, bx, by, bw, bh, 0, 0, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(t.c, 0, 0, tw, th, bx + ox, by, bw, bh);
        ctx.imageSmoothingEnabled = true;
      }
      ctx.restore();
    },
  },
  lens: {
    name: 'Lens', icon: '🔮', cat: 'cinematic',
    p: { amount: { label: 'Softness', min: 0.05, max: 1, def: 0.45, step: 0.05 } },
    post(ctx, W, H, p) {
      const s = scratchCanvas('lens', W, H);
      s.x.clearRect(0, 0, W, H);
      s.x.filter = `blur(${Math.round((W / 60) * p.amount)}px)`;
      s.x.drawImage(ctx.canvas, 0, 0);
      s.x.filter = 'none';
      // keep only the edges of the blurred copy
      const g = s.x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.22, W / 2, H / 2, Math.max(W, H) * 0.66);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      s.x.globalCompositeOperation = 'destination-in';
      s.x.fillStyle = g;
      s.x.fillRect(0, 0, W, H);
      s.x.globalCompositeOperation = 'source-over';
      ctx.drawImage(s.c, 0, 0);
    },
  },
  leak: {
    name: 'Light Leak', icon: '🌅', cat: 'cinematic',
    p: {
      intensity: { label: 'Intensity', min: 0.05, max: 1, def: 0.5, step: 0.05 },
      speed: { label: 'Drift', min: 0.1, max: 2, def: 0.5, step: 0.1 },
      color: { label: 'Color', type: 'color', def: '#ff8a3c' },
    },
    post(ctx, W, H, p, env, key, tSec) {
      const t = tSec * p.speed;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 2; i++) {
        const cx = W * (0.5 + 0.55 * Math.sin(t * (0.7 + i * 0.5) + i * 2.4));
        const cy = H * (0.35 + 0.45 * Math.sin(t * (0.5 + i * 0.4) + i * 1.7));
        const r = Math.max(W, H) * (0.35 + 0.12 * Math.sin(t + i));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, rgba(p.color || '#ff8a3c', 0.5 * p.intensity));
        g.addColorStop(0.6, rgba(p.color || '#ff8a3c', 0.16 * p.intensity));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
    },
  },
  cblur: {
    name: 'Cinematic Blur', icon: '🎞️', cat: 'cinematic',
    p: {
      amount: { label: 'Blur', min: 0.05, max: 1, def: 0.45, step: 0.05 },
      center: { label: 'Center size', min: 0.2, max: 0.8, def: 0.5, step: 0.05 },
    },
    post(ctx, W, H, p) {
      const s = scratchCanvas('cblur', W, H);
      s.x.clearRect(0, 0, W, H);
      s.x.filter = `blur(${Math.round((W / 40) * p.amount)}px)`;
      s.x.drawImage(ctx.canvas, 0, 0);
      s.x.filter = 'none';
      // keep only top/bottom of the blurred copy (tilt-shift)
      const g = s.x.createLinearGradient(0, 0, 0, H);
      const c = (1 - clamp(p.center, 0.1, 0.9)) / 2;
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(clamp(c, 0, 0.45), 'rgba(0,0,0,0)');
      g.addColorStop(clamp(1 - c, 0.55, 1), 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      s.x.globalCompositeOperation = 'destination-in';
      s.x.fillStyle = g;
      s.x.fillRect(0, 0, W, H);
      s.x.globalCompositeOperation = 'source-over';
      ctx.drawImage(s.c, 0, 0);
    },
  },
  spin: {
    name: 'Spin', icon: '🌀', cat: 'dynamic',
    p: {
      amount: { label: 'Angle', min: 1, max: 60, def: 12, step: 1 },
      rate: { label: 'Rate', min: 0.2, max: 4, def: 1, step: 0.1 },
    },
    geom(p, prog, localT) {
      return { rot: Math.sin(localT * Math.PI * 2 * p.rate) * p.amount * Math.PI / 180 };
    },
  },
  pulse: {
    name: 'Pulse', icon: '💓', cat: 'dynamic',
    p: {
      amount: { label: 'Strength', min: 0.02, max: 0.4, def: 0.1, step: 0.01 },
      rate: { label: 'BPM-ish', min: 0.5, max: 8, def: 2, step: 0.1 },
    },
    geom(p, prog, localT) {
      const phase = (localT * p.rate) % 1;
      return { scale: 1 + p.amount * pulse(phase, 0.25, 6) };
    },
    post(ctx, W, H, p, env, key, tSec) {
      const phase = (tSec * p.rate) % 1;
      const e = pulse(phase, 0.25, 6);
      if (e <= 0.03) return;
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = rgba('#ffffff', 0.25 * e);
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    },
  },
  warp: {
    name: 'Warp', icon: '🌊', cat: 'dynamic',
    p: {
      amount: { label: 'Amount', min: 0.05, max: 1, def: 0.4, step: 0.05 },
      rate: { label: 'Speed', min: 0.2, max: 6, def: 1.5, step: 0.1 },
    },
    post(ctx, W, H, p, env, key, tSec) {
      const strips = 28;
      const s = scratchCanvas('warp', W, H);
      s.x.clearRect(0, 0, W, H); s.x.drawImage(ctx.canvas, 0, 0);
      const sh = H / strips;
      ctx.save(); ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < strips; i++) {
        const ph = Math.sin(tSec * p.rate * Math.PI * 2 + i * 0.45);
        const off = ph * W * 0.035 * p.amount;
        const sy = i * sh;
        const squeeze = 1 + ph * 0.06 * p.amount;
        ctx.drawImage(s.c, 0, sy, W, sh + 1, off, sy + (sh * (1 - squeeze)) / 2, W, sh * squeeze + 1);
      }
      ctx.restore();
    },
  },

};

const hash = (n) => { let x = Math.imul((n * 1e4) | 0 ^ 0x9E3779B9, 0x85EBCA6B); x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };

function rgbPass(ctx, W, H, amount, alpha, tSec, seed, angle = 0) {
  const s = scratchCanvas('rgbpass', W, H);
  s.x.clearRect(0, 0, W, H); s.x.drawImage(ctx.canvas, 0, 0);
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad) * amount, dy = Math.sin(rad) * amount;
  ctx.save();
  if (svgFilterWorks()) {
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.filter = 'url(#tx-r)'; ctx.drawImage(s.c, -dx, -dy);
    ctx.filter = 'url(#tx-g)'; ctx.drawImage(s.c, 0, 0);
    ctx.filter = 'url(#tx-b)'; ctx.drawImage(s.c, dx, dy);
  } else {
    ctx.globalAlpha = 0.3 * alpha;
    ctx.filter = 'hue-rotate(110deg) saturate(3)';
    ctx.drawImage(s.c, -dx, -dy);
    ctx.filter = 'hue-rotate(-110deg) saturate(3)';
    ctx.drawImage(s.c, dx, dy);
  }
  ctx.restore();
}

let _noiseTile = null, _noiseN = -1;
function noiseTile(n) {
  if (_noiseTile && _noiseN === n % 8) return _noiseTile;
  const size = 128;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d');
  const img = x.createImageData(size, size);
  const rnd = srand(n * 7919 + 13);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 90 + rnd() * 120;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  _noiseTile = c; _noiseN = n % 8;
  return c;
}


/* TRALIX FX library categories */
export const FX_CATS = {
  gaming: { label: 'Gaming', icon: '🎮', types: ['killflash', 'impact', 'shake', 'scope', 'hitzoom', 'velocity', 'glitch', 'rgb', 'chroma', 'distblock'] },
  cinematic: { label: 'Cinematic', icon: '🎬', types: ['film', 'mblur', 'glow', 'vignette', 'lens', 'leak', 'cblur', 'cinematic'] },
  dynamic: { label: 'Dynamic', icon: '⚡', types: ['shake', 'zoom', 'spin', 'flash', 'pulse', 'distortion', 'warp'] },
};

/* ---------------- FX / grade presets ---------------- */
export const FX_PRESETS = [
  { id: 'sniper', name: 'Sniper', icon: '🎯', adj: { contrast: 0.18, saturation: -0.12, shadows: -0.12, temperature: -0.15, vignette: 0.35, sharpen: 0.4 }, fx: [] },
  { id: 'quickscope', name: 'Quickscope', icon: '🔭', adj: { contrast: 0.25, sharpen: 0.55, shadows: -0.1 }, fx: [{ type: 'zoom', p: { amount: 0.18, rate: 1.2 } }] },
  { id: 'shotgun', name: 'Shotgun', icon: '💥', adj: { contrast: 0.2, temperature: 0.15, saturation: 0.1 }, fx: [{ type: 'shake', p: { intensity: 0.55, speed: 26 } }, { type: 'flash', p: { amount: 0.5, rate: 1.5 } }] },
  { id: 'neon', name: 'Neon Night', icon: '🌆', adj: { contrast: 0.15, saturation: 0.3, shadows: -0.12 }, fx: [{ type: 'glow', p: { amount: 0.4 } }] },
  { id: 'br', name: 'Battle Royale', icon: '🪂', adj: { contrast: 0.15, saturation: 0.1, vignette: 0.3 }, fx: [{ type: 'cinematic', p: { bars: 0.11, warmth: 0.6 } }] },
  { id: 'vhs', name: 'VHS Retro', icon: '📼', adj: { fade: 0.12, contrast: 0.08 }, fx: [{ type: 'vhs', p: { amount: 0.55 } }] },
  { id: 'film', name: 'Film Look', icon: '🎞️', adj: { fade: 0.08, contrast: 0.1 }, fx: [{ type: 'film', p: { amount: 0.5 } }] },
  { id: 'glitch', name: 'Glitch Core', icon: '📺', adj: { contrast: 0.12 }, fx: [{ type: 'glitch', p: { intensity: 0.5, speed: 8 } }] },
  { id: 'clutch', name: 'Cold Clutch', icon: '🥶', adj: { saturation: -0.3, contrast: 0.2, shadows: -0.15, vignette: 0.4 }, fx: [{ type: 'glow', p: { amount: 0.25 } }] },
  { id: 'ranked', name: 'Ranked Clean', icon: '🏆', adj: { contrast: 0.08, saturation: 0.06, sharpen: 0.35 }, fx: [] },
];

export const TRALIX_FILTERS = [
  // gaming
  { id: 'none', name: 'Original', cat: 'gaming', adj: {} },
  { id: 'sniper', name: 'Sniper', cat: 'gaming', icon: '🎯', adj: { contrast: 0.18, saturation: -0.12, shadows: -0.12, temperature: -0.15, vignette: 0.35, sharpen: 0.4 } },
  { id: 'quickscope', name: 'Quickscope', cat: 'gaming', icon: '🔭', adj: { contrast: 0.25, sharpen: 0.55, shadows: -0.1 } },
  { id: 'shotgun', name: 'Shotgun', cat: 'gaming', icon: '💥', adj: { contrast: 0.2, temperature: 0.15, saturation: 0.1 } },
  { id: 'ranked', name: 'Ranked Pro', cat: 'gaming', icon: '🏆', adj: { contrast: 0.1, saturation: 0.05, sharpen: 0.35 } },
  { id: 'gg', name: 'GG Glow', cat: 'gaming', icon: '🎮', adj: { contrast: 0.14, saturation: 0.22, exposure: 0.04 }, fx: [{ type: 'glow', p: { amount: 0.3 } }] },
  // cinematic
  { id: 'cine', name: 'Cinematic', cat: 'cinematic', icon: '🎬', adj: { contrast: 0.14, saturation: 0.04, temperature: -0.06, shadows: -0.1, vignette: 0.22, fade: 0.05 } },
  { id: 'teal', name: 'Teal & Orange', cat: 'cinematic', icon: '🌇', adj: { contrast: 0.16, saturation: 0.12, temperature: -0.1, tint: 0.06, vignette: 0.2 } },
  { id: 'filmic', name: 'Filmic', cat: 'cinematic', icon: '🎞️', adj: { fade: 0.1, contrast: 0.1 }, fx: [{ type: 'film', p: { amount: 0.45 } }] },
  { id: 'leak', name: 'Sunset Leak', cat: 'cinematic', icon: '🌅', adj: { temperature: 0.12, fade: 0.06 }, fx: [{ type: 'leak', p: { intensity: 0.5, speed: 0.4 } }] },
  // dark
  { id: 'coldblood', name: 'Cold Blood', cat: 'dark', icon: '🥶', adj: { temperature: -0.22, contrast: 0.12, saturation: -0.08, shadows: -0.12 } },
  { id: 'darkpop', name: 'Dark Pop', cat: 'dark', icon: '🌑', adj: { contrast: 0.22, saturation: 0.15, shadows: -0.2, highlights: -0.05, vignette: 0.25 } },
  { id: 'midnight', name: 'Midnight', cat: 'dark', icon: '🌙', adj: { exposure: -0.1, contrast: 0.18, saturation: -0.05, shadows: -0.18, vignette: 0.4 } },
  { id: 'noir', name: 'Noir', cat: 'dark', icon: '🎭', adj: { saturation: -1, contrast: 0.3, vignette: 0.35, sharpen: 0.3 } },
  // vibrant
  { id: 'vivid', name: 'Vivid Gaming', cat: 'vibrant', icon: '⚡', adj: { saturation: 0.28, contrast: 0.16, sharpen: 0.25, highlights: 0.06 } },
  { id: 'neonnight', name: 'Neon Night', cat: 'vibrant', icon: '🌆', adj: { contrast: 0.18, saturation: 0.32, exposure: -0.06, shadows: -0.14 }, fx: [{ type: 'glow', p: { amount: 0.35 } }] },
  { id: 'pop', name: 'Pop', cat: 'vibrant', icon: '🍭', adj: { saturation: 0.4, contrast: 0.1, brightness: 0.05 } },
  { id: 'retro', name: 'Warm Retro', cat: 'vibrant', icon: '📻', adj: { temperature: 0.2, fade: 0.14, contrast: 0.06, saturation: -0.05 } },
  // anime
  { id: 'anime', name: 'Anime Pop', cat: 'anime', icon: '🌸', adj: { saturation: 0.45, contrast: 0.16, brightness: 0.06, sharpen: 0.3 }, fx: [{ type: 'glow', p: { amount: 0.28 } }] },
  { id: 'animenight', name: 'Anime Night', cat: 'anime', icon: '🌃', adj: { saturation: 0.35, contrast: 0.2, exposure: -0.04, shadows: -0.12, temperature: -0.08 }, fx: [{ type: 'glow', p: { amount: 0.4 } }] },
  { id: 'manga', name: 'Manga', cat: 'anime', icon: '🖋️', adj: { saturation: -0.85, contrast: 0.35, sharpen: 0.6, brightness: 0.04 } },
  { id: 'dreamy', name: 'Dreamy', cat: 'anime', icon: '💫', adj: { fade: 0.16, saturation: 0.12, exposure: 0.08, blur: 0.5 } },
];
export const GRADE_PRESETS = TRALIX_FILTERS; // backwards-compat alias

/* ---------------- transitions ---------------- */
export const TRANSITIONS = {
  none: { name: 'None', icon: '∅' },
  fade: { name: 'Fade', icon: '◐' },
  dissolve: { name: 'Dissolve', icon: '▨' },
  zoom: { name: 'Zoom', icon: '⤢' },
  swipe: { name: 'Swipe', icon: '⇥' },
  spin: { name: 'Spin', icon: '🔄' },
  glitch: { name: 'Glitch', icon: '📺' },
  flash: { name: 'Flash', icon: '⚡' },
  blur: { name: 'Blur', icon: '🌫️' },
  shake: { name: 'Shake', icon: '📳' },
  rgb: { name: 'RGB', icon: '🌈' },
  pan: { name: 'Camera Move', icon: '🎥' },
};

/* draw a transition frame: composite A (outgoing, canvas) and B (incoming) at progress p 0..1 */
export function drawTransition(ctx, A, B, type, p, W, H, tSec) {
  const a = easeInOut(p);
  switch (type) {
    case 'fade':
      ctx.drawImage(A, 0, 0);
      ctx.save(); ctx.globalAlpha = a; ctx.drawImage(B, 0, 0); ctx.restore();
      break;
    case 'dissolve': {
      ctx.drawImage(A, 0, 0);
      // dissolve via noise threshold wipe
      const s = scratchCanvas('diss', W, H);
      s.x.clearRect(0, 0, W, H);
      s.x.drawImage(B, 0, 0);
      const img = s.x.getImageData(0, 0, W, H);
      const d = img.data;
      const rnd = srand(1234);
      const thr = a * 0.9 + 0.05;
      for (let i = 3; i < d.length; i += 4) { if (rnd() > thr) d[i] = 0; }
      s.x.putImageData(img, 0, 0);
      ctx.drawImage(s.c, 0, 0);
      break;
    }
    case 'zoom': {
      ctx.save();
      const sA = 1 + 0.4 * a; ctx.translate(W / 2, H / 2); ctx.scale(sA, sA); ctx.globalAlpha = 1 - a * 0.6;
      ctx.drawImage(A, -W / 2, -H / 2); ctx.restore();
      ctx.save();
      const sB = 1.35 - 0.35 * easeOut(a); ctx.globalAlpha = a; ctx.translate(W / 2, H / 2); ctx.scale(sB, sB);
      ctx.drawImage(B, -W / 2, -H / 2); ctx.restore();
      break;
    }
    case 'swipe':
      ctx.drawImage(A, 0, 0);
      ctx.save(); ctx.translate(W * easeOut(a), 0); ctx.drawImage(B, 0, 0);
      ctx.fillStyle = 'rgba(0,229,255,0.35)'; ctx.fillRect(-4, 0, 4, H); ctx.restore();
      break;
    case 'spin':
      ctx.save();
      ctx.translate(W / 2, H / 2); ctx.scale(1 - a * 0.3, 1 - a * 0.3); ctx.rotate(a * 0.6); ctx.globalAlpha = 1 - a;
      ctx.drawImage(A, -W / 2, -H / 2); ctx.restore();
      ctx.save();
      ctx.translate(W / 2, H / 2); const sB = 0.6 + 0.4 * easeOut(a);
      ctx.scale(sB, sB); ctx.rotate(-(1 - a) * 0.6); ctx.globalAlpha = a;
      ctx.drawImage(B, -W / 2, -H / 2); ctx.restore();
      break;
    case 'glitch': {
      const src = a < 0.5 ? A : B;
      ctx.drawImage(src, 0, 0);
      const rnd = srand(Math.floor(tSec * 60));
      const slices = 5 + Math.floor(rnd() * 6);
      const s = scratchCanvas('tglitch', W, H);
      s.x.clearRect(0, 0, W, H); s.x.drawImage(ctx.canvas, 0, 0);
      for (let i = 0; i < slices; i++) {
        const sy = rnd() * H, sh = (0.02 + rnd() * 0.1) * H;
        const off = (rnd() - 0.5) * W * 0.2;
        ctx.clearRect(0, sy, W, sh);
        ctx.drawImage(s.c, 0, sy, W, sh, off, sy, W, sh);
      }
      rgbPass(ctx, W, H, 8 * (1 - Math.abs(a - 0.5) * 2) * (W / 1280), 0.7, tSec, 7);
      break;
    }
    case 'flash':
      if (a < 0.5) ctx.drawImage(A, 0, 0); else ctx.drawImage(B, 0, 0);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,255,255,${(1 - Math.abs(a - 0.5) * 2).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H); ctx.restore();
      break;
    case 'blur':
      ctx.save(); ctx.filter = `blur(${(a * W / 60).toFixed(1)}px)`; ctx.globalAlpha = 1; ctx.drawImage(A, 0, 0); ctx.restore();
      ctx.save(); ctx.filter = `blur(${((1 - a) * W / 60).toFixed(1)}px)`; ctx.globalAlpha = a; ctx.drawImage(B, 0, 0); ctx.restore();
      break;
    case 'shake': {
      const e = (1 - Math.abs(a - 0.5) * 2);
      const rnd = srand(Math.floor(tSec * 90) + 5);
      ctx.save();
      ctx.translate((rnd() - 0.5) * W * 0.05 * e, (rnd() - 0.5) * H * 0.05 * e);
      ctx.drawImage(A, 0, 0); ctx.restore();
      ctx.save();
      ctx.translate((rnd() - 0.5) * W * 0.05 * e, (rnd() - 0.5) * H * 0.05 * e);
      ctx.globalAlpha = a; ctx.drawImage(B, 0, 0); ctx.restore();
      break;
    }
    case 'rgb':
      ctx.drawImage(a < 0.5 ? A : B, 0, 0);
      rgbPass(ctx, W, H, 14 * (1 - Math.abs(a - 0.5) * 2) * (W / 1280), 0.9, tSec, 3);
      break;
    case 'pan':
      ctx.save(); ctx.translate(-W * 0.25 * easeOut(a), 0); ctx.scale(1.12, 1.12);
      ctx.globalAlpha = 1 - a; ctx.drawImage(A, 0, 0); ctx.restore();
      ctx.save(); ctx.translate(W * 0.25 * (1 - easeOut(a)), 0); ctx.scale(1.12, 1.12);
      ctx.globalAlpha = a; ctx.drawImage(B, 0, 0); ctx.restore();
      break;
    default:
      ctx.drawImage(a < 0.5 ? A : B, 0, 0);
  }
}
