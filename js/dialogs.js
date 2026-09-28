/* TRALIX EDITOR — modal dialogs: text editor, speed/ramp, crop/rotate, volume,
   beat sync studio, project settings, generic confirm/prompt */
import { clamp, el, fmtTime } from './util.js';
import { FONT_STACKS } from './render.js';
import { clipDuration, clipsSorted, splitClip, findClip } from './model.js';
import { mediaMap, peekAudioBuffer, getAudioBuffer } from './media.js';
import { detectBeats } from './audio.js';

/* ---------------- modal framework ---------------- */
export function openModal({ title, body, actions = [], onClose = null, width = 0, pad = true }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal-box' + (width ? ' wide' : ''), style: width ? { maxWidth: width + 'px' } : {} });
  const head = el('div', { class: 'modal-head' },
    el('div', { class: 'modal-title' }, title),
    el('button', { class: 'modal-close', onclick: () => close() }, '✕'));
  const bodyEl = el('div', { class: 'modal-body' + (pad ? '' : ' nopad') });
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  const foot = el('div', { class: 'modal-foot' });
  for (const a of actions.filter(Boolean)) {
    foot.append(el('button', { class: 'btn ' + (a.kind || 'ghost'), onclick: () => { a.onclick && a.onclick(); if (a.closes !== false) close(); } }, a.label));
  }
  box.append(head, bodyEl, foot);
  backdrop.append(box);
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));
  function close() {
    backdrop.classList.remove('show');
    setTimeout(() => { backdrop.remove(); onClose && onClose(); }, 180);
  }
  return { close, box, bodyEl };
}

export function confirmDlg(msg, onYes, yesLabel = 'Confirm', danger = true) {
  openModal({
    title: 'Confirm', body: el('p', { class: 'confirm-msg' }, msg),
    actions: [
      { label: 'Cancel', kind: 'ghost', closes: true },
      { label: yesLabel, kind: danger ? 'danger' : 'primary', onclick: onYes },
    ],
    width: 380,
  });
}

export function promptDlg(title, value, onOk, placeholder = '') {
  const input = el('input', { class: 'input', type: 'text', value: value || '', placeholder });
  openModal({
    title, body: input,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'OK', kind: 'primary', onclick: () => onOk(input.value.trim()) },
    ],
    width: 380,
  });
  setTimeout(() => input.focus(), 60);
}

/* ---------------- small controls ---------------- */
export function slider(labelText, value, min, max, step, onInput, fmt = v => v.toFixed(2)) {
  const val = el('span', { class: 'slider-val' }, fmt(value));
  const input = el('input', { type: 'range', min, max, step, value });
  input.addEventListener('input', () => { val.textContent = fmt(parseFloat(input.value)); onInput(parseFloat(input.value)); });
  return el('div', { class: 'slider-row' }, el('label', {}, labelText), input, val);
}
export function segButtons(options, active, onPick) {
  const host = el('div', { class: 'seg' });
  const btns = options.map(o => {
    const b = el('button', { class: 'seg-btn' + (o.id === active ? ' on' : '') }, o.label);
    b.addEventListener('click', () => { btns.forEach(x => x.classList.remove('on')); b.classList.add('on'); onPick(o.id); });
    host.append(b);
    return b;
  });
  return host;
}
function colorInput(labelText, value, onInput) {
  const input = el('input', { type: 'color', value: value || '#ffffff' });
  input.addEventListener('input', () => onInput(input.value));
  return el('div', { class: 'color-row' }, el('label', {}, labelText), input);
}
export function toggle(labelText, value, onChange) {
  const t = el('div', { class: 'toggle' + (value ? ' on' : '') }, el('div', { class: 'knob' }));
  t.addEventListener('click', () => { const on = t.classList.toggle('on'); onChange(on); });
  return el('div', { class: 'toggle-row' }, el('label', {}, labelText), t);
}

/* ================= TEXT EDITOR ================= */
export function textEditor(api, clip) {
  const c = clip;
  api.beginEdit();
  const ta = el('textarea', { class: 'input ta', rows: 3 }, c.text);
  const upd = () => { api.player.requestDraw(); };
  ta.addEventListener('input', () => { api.mutateLive(() => { c.text = ta.value; }); api.timeline.layout(); upd(); });

  const body = el('div', { class: 'text-editor' });
  body.append(
    el('div', { class: 'field-label' }, 'Text'),
    ta,
    el('div', { class: 'field-label' }, 'Font'),
    segButtons(Object.keys(FONT_STACKS).map(f => ({ id: f, label: f })), c.font, id => { api.mutateLive(() => { c.font = id; }); api.timeline.layout(); upd(); }),
    el('div', { class: 'row2' },
      (() => {
        const b = el('button', { class: 'btn small' + (c.weight >= 700 ? ' primary' : '') }, 'B');
        b.style.fontWeight = '800';
        b.addEventListener('click', () => { api.mutateLive(() => { c.weight = c.weight >= 700 ? 400 : 800; }); b.classList.toggle('primary'); upd(); });
        return b;
      })(),
      (() => {
        const b = el('button', { class: 'btn small' + (c.italic ? ' primary' : '') }, 'I');
        b.style.fontStyle = 'italic';
        b.addEventListener('click', () => { api.mutateLive(() => { c.italic = !c.italic; }); b.classList.toggle('primary'); upd(); });
        return b;
      })(),
      (() => {
        const b = el('button', { class: 'btn small' + (c.uppercase ? ' primary' : '') }, 'AA');
        b.addEventListener('click', () => { api.mutateLive(() => { c.uppercase = !c.uppercase; }); b.classList.toggle('primary'); upd(); });
        return b;
      })(),
    ),
    slider('Size', c.size, 2, 30, 0.5, v => { api.mutateLive(() => { c.size = v; }); upd(); }, v => v.toFixed(1)),
    slider('Letter spacing', c.letterSpacing, -2, 20, 0.5, v => { api.mutateLive(() => { c.letterSpacing = v; }); upd(); }, v => v.toFixed(1)),
    slider('Line spacing', c.lineHeight, 0.7, 2.5, 0.05, v => { api.mutateLive(() => { c.lineHeight = v; }); upd(); }, v => v.toFixed(2)),
    el('div', { class: 'field-label' }, 'Alignment'),
    segButtons([{ id: 'left', label: '⬅' }, { id: 'center', label: '↔' }, { id: 'right', label: '➡' }], c.align, id => { api.mutateLive(() => { c.align = id; }); upd(); }),
    el('div', { class: 'row2 tight' },
      colorInput('Color', c.color, v => { api.mutateLive(() => { c.color = v; }); upd(); }),
      colorInput('Outline', c.outline.color, v => { api.mutateLive(() => { c.outline.color = v; }); upd(); }),
    ),
    slider('Outline width', c.outline.w, 0, 12, 0.5, v => { api.mutateLive(() => { c.outline.w = v; }); upd(); }, v => v.toFixed(1)),
    el('div', { class: 'row2 tight' },
      colorInput('Shadow', c.shadow.color, v => { api.mutateLive(() => { c.shadow.color = v; }); upd(); }),
      colorInput('Glow', c.glow.color, v => { api.mutateLive(() => { c.glow.color = v; }); upd(); }),
    ),
    slider('Shadow blur', c.shadow.blur, 0, 30, 1, v => { api.mutateLive(() => { c.shadow.blur = v; c.shadow.y = Math.max(c.shadow.y, 0); }); upd(); }, v => v.toFixed(0)),
    toggle('Neon glow', c.glow.on, v => { api.mutateLive(() => { c.glow.on = v; }); upd(); }),
    slider('Glow strength', c.glow.strength, 0.3, 3, 0.1, v => { api.mutateLive(() => { c.glow.strength = v; }); upd(); }, v => v.toFixed(1)),
    toggle('Background box', c.bg.on, v => { api.mutateLive(() => { c.bg.on = v; }); upd(); }),
    slider('Background opacity', c.bg.opacity, 0, 1, 0.05, v => { api.mutateLive(() => { c.bg.opacity = v; }); upd(); }, v => v.toFixed(2)),
    el('div', { class: 'field-label' }, 'Animation in'),
    segButtons([
      { id: 'none', label: 'None' }, { id: 'fade', label: 'Fade' }, { id: 'slide', label: 'Slide' }, { id: 'pop', label: 'Pop' },
      { id: 'zoom', label: 'Zoom' }, { id: 'shake', label: 'Shake' }, { id: 'typewriter', label: 'Type' }, { id: 'glitch', label: 'Glitch' },
    ], c.anim.in, id => { api.mutateLive(() => { c.anim.in = id; }); upd(); }),
    el('div', { class: 'field-label' }, 'Animation out'),
    segButtons([
      { id: 'none', label: 'None' }, { id: 'fade', label: 'Fade' }, { id: 'slide', label: 'Slide' }, { id: 'pop', label: 'Pop' },
      { id: 'zoom', label: 'Zoom' },
    ], c.anim.out, id => { api.mutateLive(() => { c.anim.out = id; }); upd(); }),
    slider('Anim duration', c.anim.dur, 0.1, 2, 0.05, v => { api.mutateLive(() => { c.anim.dur = v; }); upd(); }, v => v.toFixed(2)),
    el('div', { class: 'field-label' }, 'Position'),
    slider('X', c.x, 0, 1, 0.01, v => { api.mutateLive(() => { c.x = v; }); upd(); }, v => Math.round(v * 100) + '%'),
    slider('Y', c.y, 0, 1, 0.01, v => { api.mutateLive(() => { c.y = v; }); upd(); }, v => Math.round(v * 100) + '%'),
  );
  openModal({
    title: 'Text',
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost', onclick: () => api.cancelEdit() },
      { label: 'Done', kind: 'primary', onclick: () => { api.timeline.layout(); } },
    ],
  });
}

/* ================= SPEED EDITOR ================= */
export function speedEditor(api, clip) {
  api.beginEdit();
  const speedLabel = el('div', { class: 'big-num' }, (clip.speed || 1).toFixed(2) + '×');
  const newDur = el('div', { class: 'hint center' }, '');
  const updateDur = () => {
    const src = clip.out - clip.in;
    newDur.textContent = `Clip length: ${(src / (clip.speed || 1)).toFixed(2)}s  (source ${src.toFixed(2)}s)`;
  };
  updateDur();
  const apply = v => {
    api.mutateLive(() => { clip.speed = clamp(v, 0.1, 8); });
    speedLabel.textContent = (clip.speed).toFixed(2) + '×';
    updateDur();
    api.timeline.layout();
    api.player.requestDraw();
  };
  const sl = slider('Speed', clip.speed || 1, 0.1, 8, 0.05, apply, v => v.toFixed(2) + '×');
  const presets = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];
  const grid = el('div', { class: 'preset-grid' },
    ...presets.map(p => el('button', {
      class: 'preset-btn' + (Math.abs((clip.speed || 1) - p) < 0.001 ? ' on' : ''),
      onclick: e => { grid.querySelectorAll('.on').forEach(n => n.classList.remove('on')); e.target.classList.add('on'); apply(p); },
    }, p + '×')));
  const customs = el('div', { class: 'row2 tight' },
    (() => {
      const i = el('input', { class: 'input', type: 'number', step: '0.05', min: '0.1', max: '8', placeholder: 'Custom speed' });
      const b = el('button', { class: 'btn small primary' }, 'Apply');
      b.addEventListener('click', () => { const v = parseFloat(i.value); if (v > 0) apply(clamp(v, 0.1, 8)); });
      return [i, b];
    })());
  let modal = null;
  const ramp = pattern => { api.applyRamp(clip, pattern); modal && modal.close(); };
  const ramps = el('div', { class: 'stack' },
    el('div', { class: 'field-label' }, 'Speed ramps (splits clip into sections)'),
    el('div', { class: 'preset-grid' },
      el('button', { class: 'preset-btn', onclick: () => ramp([1, 2, 0.5, 2, 1]) }, 'N→F→S→F→N'),
      el('button', { class: 'preset-btn', onclick: () => ramp([0.5, 2, 1]) }, 'S→F→N'),
      el('button', { class: 'preset-btn', onclick: () => ramp([1, 2, 4]) }, 'N→F→XF'),
      el('button', { class: 'preset-btn', onclick: () => ramp([2, 0.25, 2]) }, 'F→S→F'),
      el('button', { class: 'preset-btn', onclick: () => ramp([0.5, 0.25, 0.5, 1]) }, 'Slow-mo build'),
    ),
    el('div', { class: 'hint' }, 'Ramps split the clip and apply a different speed to each part.'),
  );
  const body = el('div', { class: 'speed-editor' }, speedLabel, newDur, grid, sl, customs, ramps);
  modal = openModal({
    title: 'Speed', body,
    actions: [
      { label: 'Cancel', kind: 'ghost', onclick: () => api.cancelEdit() },
      { label: 'Done', kind: 'primary' },
    ],
  });
}

/* ================= CROP / ROTATE / TRANSFORM ================= */
export function cropEditor(api, clip) {
  api.beginEdit();
  const c = clip;
  const prevCanvas = el('canvas', { class: 'crop-preview' });
  const drawPrev = () => {
    const p = api.project();
    const maxW = Math.min(560, window.innerWidth - 80);
    const maxH = Math.min(300, window.innerHeight * 0.3);
    const ar = p.width / p.height;
    prevCanvas.width = maxW; prevCanvas.height = Math.round(maxW / ar);
    if (prevCanvas.height > maxH) { prevCanvas.height = maxH; prevCanvas.width = Math.round(maxH * ar); }
    api.player.drawFrameTo(prevCanvas, api.player.t);
  };
  const upd = () => { api.mutateLive(() => { }); api.player.requestDraw(); drawPrev(); };
  const aspects = [
    { id: 'free', label: 'Free' },
    { id: '16:9', label: '16:9' }, { id: '1:1', label: '1:1' }, { id: '4:5', label: '4:5' },
    { id: '9:16', label: '9:16' }, { id: '2.35', label: '2.35:1' },
  ];
  const applyAspect = id => {
    api.mutateLive(() => {
      if (id === 'free') { c.crop = { l: 0, t: 0, r: 0, b: 0 }; return; }
      const media = mediaMap.get(c.mediaId);
      const vw = (media ? media.width : 16) || 16, vh = (media ? media.height : 9) || 9;
      let target = id === '16:9' ? 16 / 9 : id === '1:1' ? 1 : id === '4:5' ? 4 / 5 : id === '9:16' ? 9 / 16 : 2.35;
      const src = vw / vh;
      if (src > target) { // too wide -> crop sides
        const keep = target / src; const side = (1 - keep) / 2;
        c.crop = { l: side, t: 0, r: side, b: 0 };
      } else {
        const keep = src / target; const side = (1 - keep) / 2;
        c.crop = { l: 0, t: side, r: 0, b: side };
      }
    });
    refreshSliders(); upd();
  };
  const sliderHosts = {};
  const mk = (key, label) => {
    sliderHosts[key] = el('div', {});
    return sliderHosts[key];
  };
  const refreshSliders = () => {
    if (!sliderHosts.l) return;
    sliderHosts.l.innerHTML = ''; sliderHosts.r.innerHTML = ''; sliderHosts.t.innerHTML = ''; sliderHosts.b.innerHTML = '';
    sliderHosts.l.append(slider('Crop left', c.crop.l, 0, 0.45, 0.01, v => { c.crop.l = v; c.crop.r = Math.min(c.crop.r, 0.95 - v); upd(); }, v => Math.round(v * 200) / 2 + '%'));
    sliderHosts.r.append(slider('Crop right', c.crop.r, 0, 0.45, 0.01, v => { c.crop.r = v; upd(); }, v => Math.round(v * 200) / 2 + '%'));
    sliderHosts.t.append(slider('Crop top', c.crop.t, 0, 0.45, 0.01, v => { c.crop.t = v; upd(); }, v => Math.round(v * 200) / 2 + '%'));
    sliderHosts.b.append(slider('Crop bottom', c.crop.b, 0, 0.45, 0.01, v => { c.crop.b = v; upd(); }, v => Math.round(v * 200) / 2 + '%'));
  };
  const body = el('div', { class: 'crop-editor' },
    prevCanvas,
    el('div', { class: 'field-label' }, 'Aspect'),
    segButtons(aspects, 'free', applyAspect),
    mk('l'), mk('r'), mk('t'), mk('b'),
    el('div', { class: 'field-label' }, 'Rotate & flip'),
    el('div', { class: 'preset-grid' },
      el('button', { class: 'preset-btn', onclick: () => { api.mutateLive(() => { c.rotation = 0; }); upd(); } }, '0°'),
      el('button', { class: 'preset-btn', onclick: () => { api.mutateLive(() => { c.rotation = 90; }); upd(); } }, '90°'),
      el('button', { class: 'preset-btn', onclick: () => { api.mutateLive(() => { c.rotation = 180; }); upd(); } }, '180°'),
      el('button', { class: 'preset-btn', onclick: () => { api.mutateLive(() => { c.rotation = 270; }); upd(); } }, '270°'),
      el('button', { class: 'preset-btn' + (c.flipH ? ' on' : ''), onclick: e => { api.mutateLive(() => { c.flipH = !c.flipH; }); e.target.classList.toggle('on'); upd(); } }, 'Flip H'),
      el('button', { class: 'preset-btn' + (c.flipV ? ' on' : ''), onclick: e => { api.mutateLive(() => { c.flipV = !c.flipV; }); e.target.classList.toggle('on'); upd(); } }, 'Flip V'),
    ),
    slider('Zoom', c.scale, 0.5, 4, 0.05, v => { api.mutateLive(() => { c.scale = v; }); upd(); }, v => v.toFixed(2) + '×'),
    slider('Pan X', c.x, -0.5, 0.5, 0.01, v => { api.mutateLive(() => { c.x = v; }); upd(); }, v => Math.round(v * 100) + '%'),
    slider('Pan Y', c.y, -0.5, 0.5, 0.01, v => { api.mutateLive(() => { c.y = v; }); upd(); }, v => Math.round(v * 100) + '%'),
  );
  refreshSliders();
  openModal({
    title: 'Crop · Rotate · Zoom', body,
    actions: [
      { label: 'Cancel', kind: 'ghost', onclick: () => api.cancelEdit() },
      { label: 'Done', kind: 'primary' },
    ],
  });
  drawPrev();
}

/* ================= VOLUME / FADES ================= */
export function volumeEditor(api, clip) {
  api.beginEdit();
  const c = clip;
  const upd = () => api.player.requestDraw();
  const body = el('div', { class: 'stack' },
    toggle('Mute clip', c.muted, v => { api.mutateLive(() => { c.muted = v; }); api.timeline.layout(); }),
    slider('Volume', c.volume ?? 1, 0, 2, 0.05, v => { api.mutateLive(() => { c.volume = v; }); }, v => Math.round(v * 100) + '%'),
    slider('Fade in', c.fadeIn || 0, 0, 5, 0.1, v => { api.mutateLive(() => { c.fadeIn = v; }); }, v => v.toFixed(1) + 's'),
    slider('Fade out', c.fadeOut || 0, 0, 5, 0.1, v => { api.mutateLive(() => { c.fadeOut = v; }); }, v => v.toFixed(1) + 's'),
    el('div', { class: 'hint' }, 'Fades apply to both picture and audio of the clip.'),
  );
  openModal({
    title: 'Volume & Fades', body,
    actions: [
      { label: 'Cancel', kind: 'ghost', onclick: () => api.cancelEdit() },
      { label: 'Done', kind: 'primary' },
    ],
  });
}

/* ================= BEAT SYNC STUDIO ================= */
export function beatSyncStudio(api) {
  const p = api.project();
  // find first music/audio clip
  let musicClip = null, musicTrack = null;
  for (const tr of p.tracks) {
    if (tr.kind !== 'audio') continue;
    for (const c of tr.clips) { if (!musicClip || c.start < musicClip.start) { musicClip = c; musicTrack = tr; } }
  }
  const canvas = el('canvas', { class: 'beat-canvas' });
  const status = el('div', { class: 'hint' }, musicClip ? 'Tap the pad on every beat while the track plays. Or auto-detect.' : 'Add a music clip in the Audio panel first — or use markers free-form.');
  const bpmLabel = el('div', { class: 'big-num' }, '— BPM');
  const countLabel = el('div', { class: 'hint center' }, '');

  const draw = (t = api.player.t) => {
    const maxW = Math.min(620, window.innerWidth - 72);
    canvas.width = maxW; canvas.height = 110;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0f1d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const dur = api.projectDuration();
    const px = canvas.width / dur;
    // waveform of music
    if (musicClip) {
      const media = mediaMap.get(musicClip.mediaId);
      const buf = media && peekAudioBuffer(media.id);
      if (buf && media.peaks) {
        ctx.fillStyle = 'rgba(0,229,255,0.5)';
        const total = media.duration || 1;
        for (let x = 0; x < canvas.width; x++) {
          const srcT = musicClip.in + (x / px - musicClip.start) * (musicClip.speed || 1);
          if (srcT < musicClip.in || srcT > musicClip.out) continue;
          const idx = Math.floor((srcT / total) * media.peaks.length);
          const v = media.peaks[clampI(idx, 0, media.peaks.length - 1)] || 0;
          const bh = v * 80;
          ctx.fillRect(x, (canvas.height - bh) / 2, 1, bh);
        }
      }
    }
    // markers
    ctx.fillStyle = '#b388ff';
    for (const m of p.markers) {
      ctx.fillRect(m * px - 1, 0, 2, canvas.height);
      ctx.beginPath(); ctx.moveTo(m * px - 4, 0); ctx.lineTo(m * px + 4, 0); ctx.lineTo(m * px, 7); ctx.closePath(); ctx.fill();
    }
    // playhead
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(t * px - 1, 0, 2, canvas.height);
    countLabel.textContent = p.markers.length + ' beat markers';
  };
  const clampI = (v, a, b) => Math.max(a, Math.min(b, v));

  const tapPad = el('button', { class: 'tap-pad' }, 'TAP');
  tapPad.addEventListener('pointerdown', () => {
    const p2 = api.project();
    p2.markers.push(api.player.t);
    p2.markers.sort((a, b) => a - b);
    draw();
    // bpm from last 8 intervals
    const ms = p2.markers;
    if (ms.length >= 3) {
      const gaps = [];
      for (let i = Math.max(1, ms.length - 8); i < ms.length; i++) gaps.push(ms[i] - ms[i - 1]);
      gaps.sort((a, b) => a - b);
      const med = gaps[Math.floor(gaps.length / 2)];
      if (med > 0.1) bpmLabel.textContent = Math.round(clamp(60 / med, 40, 240)) + ' BPM (tap est.)';
    }
  });

  const sens = el('input', { type: 'range', min: '1.05', max: '2', step: '0.05', value: '1.25' });
  const autoBtn = el('button', { class: 'btn primary' }, '⚡ Auto-detect beats');
  autoBtn.addEventListener('click', async () => {
    if (!musicClip) { status.textContent = 'Add music first.'; return; }
    autoBtn.disabled = true; autoBtn.textContent = 'Detecting…';
    try {
      const media = mediaMap.get(musicClip.mediaId);
      const buf = await getAudioBuffer(media);
      if (!buf) throw new Error('no audio');
      const { beats, bpm } = detectBeats(buf, { sensitivity: parseFloat(sens.value) });
      const p2 = api.project();
      const srcToTimeline = t => musicClip.start + ((t - musicClip.in) / (musicClip.speed || 1));
      p2.markers = beats.map(srcToTimeline).filter(t => t >= 0 && t <= api.projectDuration());
      bpmLabel.textContent = bpm ? bpm + ' BPM' : 'no steady beat found';
      status.textContent = `${p2.markers.length} beats detected. Use the actions below.`;
      draw();
    } catch (e) {
      status.textContent = 'Beat detection failed: ' + e.message;
    }
    autoBtn.disabled = false; autoBtn.textContent = '⚡ Auto-detect beats';
  });

  const actions2 = el('div', { class: 'stack' },
    el('div', { class: 'field-label' }, 'Apply to timeline'),
    el('div', { class: 'preset-grid' },
      el('button', { class: 'preset-btn', onclick: () => { api.snapCutsToMarkers(); draw(); } }, 'Snap cuts to beats'),
      el('button', { class: 'preset-btn', onclick: () => { api.splitAtMarkers(); draw(); } }, 'Split clips at beats'),
      el('button', { class: 'preset-btn', onclick: () => { api.autoMontage(); } }, '⚡ Auto kill-montage'),
      el('button', { class: 'preset-btn danger', onclick: () => { api.mutate('Clear markers', p2 => { p2.markers = []; }); draw(); } }, 'Clear markers'),
    ),
    el('div', { class: 'hint' }, 'Beat markers drive the kill-counter overlay, snapping and auto-montage. All offline — import music you have rights to use.'),
  );

  const body = el('div', { class: 'beat-studio stack' },
    canvas, countLabel, status,
    el('div', { class: 'row2 tight' }, tapPad, el('div', { class: 'stack grow' }, bpmLabel,
      el('div', { class: 'slider-row slim' }, el('label', {}, 'Sensitivity'), sens))),
    el('div', { class: 'row2 tight' },
      el('button', { class: 'btn small', onclick: () => api.player.toggle() }, '▶ / ⏸ Play'),
      el('button', { class: 'btn small', onclick: () => { const p2 = api.project(); p2.markers.pop(); draw(); } }, '↩ Remove last'),
    ),
    actions2,
  );
  openModal({ title: 'Beat Sync Studio', body, actions: [{ label: 'Done', kind: 'primary' }], width: 680 });
  draw();
  api.player.seek(api.player.t, { silent: true });
  const iv = setInterval(() => { if (!document.body.contains(canvas)) { clearInterval(iv); return; } draw(api.player.t); }, 120);
}

/* ================= PROJECT SETTINGS ================= */
export function projectSettings(api) {
  const p = api.project();
  api.beginEdit();
  const nameInput = el('input', { class: 'input', type: 'text', value: p.name });
  nameInput.addEventListener('input', () => api.mutateLive(() => { p.name = nameInput.value || 'Untitled Project'; }));
  const resPresets = [
    { id: '1920x1080', label: '1080p 16:9' },
    { id: '1280x720', label: '720p 16:9' },
    { id: '2560x1440', label: '1440p 16:9' },
    { id: '3840x2160', label: '4K 16:9' },
    { id: '1080x1920', label: '1080×1920 (9:16)' },
    { id: '1080x1080', label: '1080×1080 (1:1)' },
  ];
  const cur = `${p.width}x${p.height}`;
  const body = el('div', { class: 'stack' },
    el('div', { class: 'field-label' }, 'Project name'),
    nameInput,
    el('div', { class: 'field-label' }, 'Canvas resolution'),
    segButtons(resPresets, cur, id => {
      const [w, h] = id.split('x').map(Number);
      api.mutateLive(() => { p.width = w; p.height = h; });
      api.onCanvasChanged();
      api.player.requestDraw();
    }),
    el('div', { class: 'field-label' }, 'Timeline FPS (affects export default & stepping)'),
    segButtons([{ id: 24, label: '24' }, { id: 25, label: '25' }, { id: 30, label: '30' }, { id: 60, label: '60' }].map(o => ({ id: o.id, label: o.label })), p.fps, id => {
      api.mutateLive(() => { p.fps = Number(id); });
    }),
  );
  openModal({
    title: 'Project Settings', body,
    actions: [
      { label: 'Cancel', kind: 'ghost', onclick: () => api.cancelEdit() },
      { label: 'Done', kind: 'primary' },
    ],
  });
}
