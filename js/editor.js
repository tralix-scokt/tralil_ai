/* TRALIX EDITOR — editor screen: preview, transport, timeline, clip actions,
   history/undo, autosave, editing operations */
import { clamp, el, fmtTime, fmtDur, uid, toast, deepClone, debounce } from './util.js';
import { idb } from './idb.js';
import {
  newProject, findClip, clipsSorted, clipDuration, projectDuration, splitClip,
  History, snapTargets, snapTime, makeVideoClip, makeAudioClip, makeTextClip,
  makeOverlayClip, makeStillClip, DEFAULT_ADJ,
} from './model.js';
import { mediaMap, saveMediaMeta, getAudioBuffer, extractAudioFromVideo } from './media.js';
import { audioEngine, analyzeSilence } from './audio.js';
import { Player } from './player.js';
import { Timeline } from './timeline.js';
import { FX, FX_PRESETS, GRADE_PRESETS, TRANSITIONS } from './fx.js';
import { detectScenes, findHighlights } from './ai.js';
import { drawFrame, videoElSync } from './render.js';
import {
  textEditor, speedEditor, cropEditor, volumeEditor, beatSyncStudio,
  projectSettings, confirmDlg, promptDlg, openModal, slider, toggle,
} from './dialogs.js';
import { Panels } from './panels.js';
import { openExportFlow } from './export.js';
import { prefs } from './home.js';

export class EditorScreen {
  constructor(app, project) {
    this.app = app;
    this.project = project;
    // apply user preferences (e.g. snapping default from Settings)
    if (project.settings && project.settings.snap === undefined) {
      const pf = prefs.get();
      project.settings.snap = pf.snap !== false;
    }
    this.history = new History(() => this.updateHistoryUI());
    this.history.reset(project);
    this.selectedClipId = null;
    this.selectedTrackId = null;
    this.build();
    this.player = new Player(() => this.project, this.previewCanvas);
    this.player.onFrame = (t, playing) => this.onFrame(t, playing);
    this.player.onEnd = () => { };
    this.timeline = new Timeline(this.tlHost, () => this.project, {
      onSelect: clipId => this.onSelect(clipId),
      onScrub: t => this.player.seek(t, { silent: true }),
      onMutateBegin: () => this.history.push(deepClone(this.project)),
      onMutateEnd: () => this.afterChange(),
      onTrackHeader: (trackId, ev) => this.trackHeaderMenu(trackId, ev),
      onZoom: () => { },
    });
    this.panels = new Panels(this);
    this.autosave = debounce(() => this.save(), 900);
    this.timeline.layout();
    this.player.prepare().then(() => this.player.requestDraw());
    this.updateHistoryUI();
  }

  /* ---------------- build DOM ---------------- */
  build() {
    const screen = document.getElementById('screen-editor');
    screen.innerHTML = '';

    // top bar
    this.topbar = el('div', { class: 'ed-topbar' },
      el('button', { class: 'icon-btn', onclick: () => this.goBack() }, '←'),
      el('div', { class: 'ed-title', onclick: () => projectSettings(this.api()) }, this.project.name),
      el('div', { class: 'grow' }),
      el('button', { class: 'icon-btn', id: 'undo-btn', onclick: () => this.undo() }, '↩'),
      el('button', { class: 'icon-btn', id: 'redo-btn', onclick: () => this.redo() }, '↪'),
      el('button', { class: 'icon-btn', onclick: () => projectSettings(this.api()) }, '⚙'),
      el('button', { class: 'btn primary small', onclick: () => openExportFlow(this.api()) }, 'Export ⤴'),
    );

    // preview
    this.previewWrap = el('div', { class: 'preview-wrap' });
    this.previewBox = el('div', { class: 'preview-box' });
    this.previewCanvas = el('canvas', { class: 'preview-canvas' });
    this.previewCanvas.addEventListener('click', () => this.player.toggle());
    this.previewBox.append(this.previewCanvas);
    this.previewWrap.append(this.previewBox);

    // transport
    this.timeLabel = el('div', { class: 'time-label' }, '0:00 / 0:00');
    this.playBtn = el('button', { class: 'play-btn', onclick: () => this.player.toggle() }, '▶');
    this.transport = el('div', { class: 'transport' },
      el('button', { class: 'icon-btn', onclick: () => this.player.seek(0) }, '⏮'),
      el('button', { class: 'icon-btn', onclick: () => this.player.step(-1) }, '◂◂'),
      this.playBtn,
      el('button', { class: 'icon-btn', onclick: () => this.player.step(1) }, '▸▸'),
      (() => { const b = el('button', { class: 'icon-btn', onclick: e => { this.player.setLoop(!this.player.loop); b.classList.toggle('on'); } }, '🔁'); return b; })(),
      (() => { const b = el('button', { class: 'icon-btn', onclick: e => { this.player.setMuted(!this.player.muted); b.classList.toggle('on'); b.textContent = this.player.muted ? '🔇' : '🔊'; } }, '🔊'); return b; })(),
      el('div', { class: 'grow' }),
      this.timeLabel,
      this.previewWrap.requestFullscreen || document.documentElement.requestFullscreen ? el('button', { class: 'icon-btn', onclick: () => this.toggleFullscreenPreview() }, '⛶') : el('span'),
    );

    // clip action bar
    this.actionBar = el('div', { class: 'action-bar' });

    // timeline
    this.tlWrap = el('div', { class: 'ed-timeline' });
    this.tlTools = el('div', { class: 'tl-tools' },
      el('button', { class: 'tl-tool', title: 'Zoom out', onclick: () => this.timeline.zoom(this.timeline.pxPerSec * 0.7) }, '−'),
      (() => {
        const s = el('input', { type: 'range', class: 'tl-zoom', min: '8', max: '400', value: String(this.timeline ? this.timeline.pxPerSec : 60) });
        s.addEventListener('input', () => this.timeline.zoom(parseFloat(s.value)));
        this._zoomSlider = s; return s;
      })(),
      el('button', { class: 'tl-tool', title: 'Zoom in', onclick: () => this.timeline.zoom(this.timeline.pxPerSec * 1.4) }, '+'),
      el('button', { class: 'tl-tool', title: 'Fit', onclick: () => this.timeline.fit() }, '⤢'),
      el('div', { class: 'grow' }),
      el('button', { class: 'tl-tool', onclick: () => this.addTrack('video') }, '+ Video layer'),
      el('button', { class: 'tl-tool', onclick: () => this.addTrack('audio') }, '+ Audio track'),
    );
    this.tlHost = el('div', { class: 'tl-host' });
    this.tlWrap.append(this.tlTools, this.tlHost);

    // panels host + tab bar
    this.panelHost = el('div', { class: 'panel-host' });
    this.tabbar = el('div', { class: 'tabbar' });
    const tabs = [
      ['media', '🗂', 'Media'], ['audio', '🎵', 'Audio'], ['text', '🅣', 'Text'],
      ['effects', '✨', 'Effects'], ['adjust', '🎨', 'Adjust'], ['trans', '🔀', 'Trans'],
      ['export', '⤴', 'Export'],
    ];
    for (const [id, icon, label] of tabs) {
      const b = el('button', { class: 'tab-btn', dataset: { tab: id } }, el('span', { class: 'tab-icon' }, icon), el('span', { class: 'tab-label' }, label));
      b.addEventListener('click', () => this.panels.toggle(id, b));
      this.tabbar.append(b);
    }

    screen.append(this.topbar, this.previewWrap, this.transport, this.actionBar, this.tlWrap, this.panelHost, this.tabbar);

    this._keyHandler = e => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (meta && e.key === 'y') { e.preventDefault(); this.redo(); return; }
      if (e.key === ' ') { e.preventDefault(); this.player.toggle(); }
      else if (e.key === 's' || e.key === 'S') { const f = this.sel(); if (f) this.splitAtPlayhead(f.clip); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { const f = this.sel(); if (f) this.deleteClip(f.clip); }
      else if (e.key === 'ArrowLeft') this.player.step(e.shiftKey ? -10 : -1);
      else if (e.key === 'ArrowRight') this.player.step(e.shiftKey ? 10 : 1);
      else if (e.key === 'Home') this.player.seek(0);
      else if (e.key === '+' || e.key === '=') this.timeline.zoom(this.timeline.pxPerSec * 1.3);
      else if (e.key === '-') this.timeline.zoom(this.timeline.pxPerSec * 0.75);
    };
    window.addEventListener('keydown', this._keyHandler);

    // canvas sizing
    this.onCanvasChanged();
    window.addEventListener('resize', () => { this.onCanvasChanged(); this.timeline.layout(); });
  }

  onCanvasChanged() {
    const p = this.project;
    const box = this.previewBox;
    const availW = box.clientWidth || window.innerWidth - 24;
    const availH = window.innerHeight * 0.34;
    const ar = p.width / p.height;
    let w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    this.previewCanvas.style.width = w + 'px';
    this.previewCanvas.style.height = h + 'px';
    // internal render resolution capped for smooth preview (proxy scaling)
    const pq = (JSON.parse(localStorage.getItem('tralix.prefs') || '{}').previewQuality) || 'half';
    const cap = pq === 'full' ? 1920 : pq === 'quarter' ? 854 : 1280;
    const scale = Math.min(1, cap / p.width);
    this.previewCanvas.width = Math.round(p.width * scale);
    this.previewCanvas.height = Math.round(p.height * scale);
    this.player && this.player.requestDraw();
  }

  toggleFullscreenPreview() {
    const pe = this.previewWrap;
    if (!document.fullscreenElement) { pe.requestFullscreen && pe.requestFullscreen(); }
    else document.exitFullscreen();
  }

  /* ---------------- selection & actions bar ---------------- */
  onSelect(clipId) {
    this.selectedClipId = clipId;
    const found = clipId ? findClip(this.project, clipId) : null;
    this.selectedTrackId = found ? found.track.id : null;
    this.renderActionBar();
    const c = found && found.clip;
    if (c && this.player) {
      // keep playhead: no auto-seek; just redraw
      this.player.requestDraw();
    }
  }

  sel() { return this.selectedClipId ? findClip(this.project, this.selectedClipId) : null; }

  renderActionBar() {
    const found = this.sel();
    this.actionBar.innerHTML = '';
    if (!found) {
      this.actionBar.append(
        el('span', { class: 'hint grow' }, 'Tap a clip to edit · drag to move · pinch to zoom'),
        el('button', { class: 'tl-tool', onclick: () => this.addTextPreset('TITLE') }, '＋ Title'),
      );
      return;
    }
    const { track, clip } = found;
    const btn = (label, fn, cls = '') => el('button', { class: 'action-btn ' + cls, onclick: fn }, label);
    const isMedia = clip.kind === 'video' || clip.kind === 'audio';
    this.actionBar.append(
      btn('✂ Split', () => this.splitAtPlayhead(clip)),
      btn('⧉ Copy', () => this.duplicateClip(clip)),
      btn('🗑', () => this.deleteClip(clip), 'danger'),
    );
    if (clip.kind === 'video' || clip.kind === 'still') {
      this.actionBar.append(
        btn('⚡ Freeze', () => this.freezeFrame(clip)),
        btn('🔎 Crop', () => cropEditor(this.api(), clip)),
        btn('✨ FX', () => this.panels.open('effects')),
        btn('🎨 Grade', () => this.panels.open('adjust')),
        btn('🔀 Trans', () => this.panels.open('trans')),
      );
    }
    if (isMedia) {
      this.actionBar.append(
        btn('⏩ Speed', () => speedEditor(this.api(), clip)),
        btn('🔊 Vol', () => volumeEditor(this.api(), clip)),
        btn(clip.muted ? '🔇→🔊' : '🔊→🔇', () => { this.mutate('Mute', p => { const f = findClip(p, clip.id); if (f) f.clip.muted = !f.clip.muted; }); this.renderActionBar(); this.timeline.layout(); }),
      );
    }
    if (clip.kind === 'video') {
      this.actionBar.append(btn('🎵 Extract audio', () => this.extractAudio(clip)));
    }
    if (clip.kind === 'text') {
      this.actionBar.append(btn('✎ Edit', () => textEditor(this.api(), clip)));
    }
    if (clip.kind === 'overlay') {
      this.actionBar.append(btn('⚙ Style', () => this.overlayStyle(clip)));
    }
  }

  overlayStyle(clip) {
    this.beginEdit();
    const c = clip;
    const defaults = {
      frame: ['color'],
      lowerthird: ['color', 'text', 'sub'],
      rec: ['color'],
      killfeed: ['color', 'interval', 'messages'],
      xp: ['text', 'interval'],
      counter: ['prefix', 'start', 'per', 'color'],
      vs: ['text', 'color'],
    };
    const body = el('div', { class: 'stack' });
    const p = c.p;
    if (p.text !== undefined || defaults[c.sub]?.includes('text') || defaults[c.sub]?.includes('messages') || defaults[c.sub]?.includes('prefix')) {
      if (['lowerthird', 'xp', 'vs'].includes(c.sub)) {
        const i = el('input', { class: 'input', value: p.text || '' });
        i.addEventListener('input', () => { this.mutateLive(() => { p.text = i.value; }); this.player.requestDraw(); });
        body.append(el('div', { class: 'field-label' }, 'Text'), i);
      }
      if (c.sub === 'lowerthird') {
        const i = el('input', { class: 'input', value: p.sub || '' });
        i.addEventListener('input', () => { this.mutateLive(() => { p.sub = i.value; }); this.player.requestDraw(); });
        body.append(el('div', { class: 'field-label' }, 'Subtitle'), i);
      }
      if (c.sub === 'counter') {
        const i = el('input', { class: 'input', value: p.prefix || 'KILLS' });
        i.addEventListener('input', () => { this.mutateLive(() => { p.prefix = i.value; }); this.player.requestDraw(); });
        body.append(el('div', { class: 'field-label' }, 'Counter label'), i);
        body.append(slider('Count every N markers', p.per || 1, 1, 10, 1, v => { this.mutateLive(() => { p.per = v; }); this.player.requestDraw(); }, v => String(v)));
      }
      if (c.sub === 'killfeed') {
        const i = el('input', { class: 'input', value: (p.messages || []).join(', ') });
        i.addEventListener('input', () => { this.mutateLive(() => { p.messages = i.value.split(',').map(s => s.trim()).filter(Boolean); }); this.player.requestDraw(); });
        body.append(el('div', { class: 'field-label' }, 'Feed messages (comma separated)'), i);
      }
    }
    if (c.sub !== 'rec' && c.sub !== 'frame') {
      body.append(slider('Interval', p.interval || 1.5, 0.4, 6, 0.1, v => { this.mutateLive(() => { p.interval = v; }); this.player.requestDraw(); }, v => v.toFixed(1) + 's'));
    }
    const col = el('input', { type: 'color', value: p.color || '#00e5ff' });
    col.addEventListener('input', () => { this.mutateLive(() => { p.color = col.value; }); this.player.requestDraw(); });
    body.append(el('div', { class: 'color-row' }, el('label', {}, 'Accent color'), col));
    openModal({
      title: 'Overlay Style', body,
      actions: [
        { label: 'Cancel', kind: 'ghost', onclick: () => this.cancelEdit() },
        { label: 'Done', kind: 'primary' },
      ],
    });
  }

  /* ---------------- editing operations ---------------- */
  api() {
    return {
      project: () => this.project,
      projectDuration: () => projectDuration(this.project),
      player: this.playerProxy(),
      timeline: this.timeline,
      beginEdit: () => this.beginEdit(),
      cancelEdit: () => this.cancelEdit(),
      mutate: (label, fn) => this.mutate(label, fn),
      mutateLive: fn => this.mutateLive(fn),
      applyRamp: (clip, pattern) => this.applyRamp(clip, pattern),
      snapCutsToMarkers: () => this.snapCutsToMarkers(),
      splitAtMarkers: () => this.splitAtMarkers(),
      autoMontage: () => this.autoMontage(),
      onCanvasChanged: () => this.onCanvasChanged(),
      openTab: name => this.panels.open(name),
    };
  }
  playerProxy() {
    const p = this.player;
    return Object.assign(Object.create(Object.getPrototypeOf(p)), p, {
      drawFrameTo: (canvas, t) => drawFrame(canvas, this.project, t),
    });
  }

  beginEdit() { this.history.push(deepClone(this.project)); }
  cancelEdit() {
    // drop the snapshot pushed by beginEdit and restore it as current
    if (this.history.undoStack.length > 1) {
      const snap = this.history.undoStack.pop();
      this._setState(JSON.parse(snap));
      this.history.redoStack = [];
      this.history.onChange(this.history);
    }
  }
  mutate(label, fn) {
    this.history.push(deepClone(this.project));
    fn(this.project);
    this.project.updatedAt = Date.now();
    this.afterChange();
  }
  mutateLive(fn) { fn(this.project); this.player.requestDraw(); }
  _setState(state) {
    const prevTracks = this.project.tracks;
    for (const tr of prevTracks) for (const c of tr.clips) Player.releaseClip(c.id);
    Object.assign(this.project, state);
    this.afterChange(true);
  }
  undo() {
    const prev = this.history.undo(this.project);
    if (prev) { this._setState(prev); toast('Undo'); } else toast('Nothing to undo');
  }
  redo() {
    const next = this.history.redo(this.project);
    if (next) { this._setState(next); toast('Redo'); } else toast('Nothing to redo');
  }
  updateHistoryUI() {
    const u = document.getElementById('undo-btn'), r = document.getElementById('redo-btn');
    if (u) u.style.opacity = this.history.canUndo ? 1 : 0.35;
    if (r) r.style.opacity = this.history.canRedo ? 1 : 0.35;
  }

  afterChange(skipTimeline) {
    if (!skipTimeline) this.timeline.layout();
    this.player.syncVideoEls(this.player.t);
    this.player.prepare().then(() => this.player.requestDraw());
    this.updateHistoryUI();
    this.autosave();
    // keep the action bar honest with the current selection (ids can change after splits/ramps)
    clearTimeout(this._abTimer);
    this._abTimer = setTimeout(() => this.renderActionBar(), 0);
  }

  /* clip ops */
  splitAtPlayhead(clip) {
    const t = this.player.t;
    this.mutate('Split', p => {
      const f = findClip(p, clip.id);
      if (!f) return;
      const parts = splitClip(f.clip, t);
      if (!parts) { toast('Move the playhead inside the clip first'); return; }
      const tr = f.track;
      const idx = tr.clips.findIndex(c => c.id === clip.id);
      tr.clips.splice(idx, 1, parts[0], parts[1]);
      Player.releaseClip(clip.id);
      this.selectedClipId = parts[1].id;
    });
  }
  duplicateClip(clip) {
    this.mutate('Duplicate', p => {
      const f = findClip(p, clip.id);
      if (!f) return;
      const copy = deepClone(clip);
      copy.id = uid();
      copy.start = clip.start + clipDuration(clip);
      // push overlapping clips on that track
      for (const c of f.track.clips) if (c.id !== clip.id && c.start >= copy.start - 0.001) c.start += clipDuration(clip);
      f.track.clips.push(copy);
      this.selectedClipId = copy.id;
    });
  }
  deleteClip(clip) {
    confirmDlg('Delete this clip from the timeline?', () => {
      this.mutate('Delete clip', p => {
        const f = findClip(p, clip.id);
        if (!f) { toast('Clip already removed'); return; }
        const dur = clipDuration(clip);
        f.track.clips = f.track.clips.filter(c => c.id !== clip.id);
        delete f.track.transitions[clip.id];
        // close the gap
        for (const c of f.track.clips) if (c.start >= clip.start) c.start = Math.max(0, c.start - dur);
        Player.releaseClip(clip.id);
        this.selectedClipId = null;
      });
      this.renderActionBar();
    }, 'Delete');
  }
  freezeFrame(clip) {
    const t = this.player.t;
    const elv = videoElSync.get(clip.id);
    if (!elv || elv.readyState < 2) { toast('Frame not ready — try again'); return; }
    const c = document.createElement('canvas');
    c.width = elv.videoWidth; c.height = elv.videoHeight;
    c.getContext('2d').drawImage(elv, 0, 0);
    const src = c.toDataURL('image/jpeg', 0.92);
    this.mutate('Freeze frame', p => {
      const f = findClip(p, clip.id);
      if (!f) return;
      const parts = splitClip(f.clip, t);
      const still = makeStillClip(src, t, 1);
      still.adj = deepClone(clip.adj || DEFAULT_ADJ());
      const tr = f.track;
      if (parts) {
        const idx = tr.clips.findIndex(x => x.id === clip.id);
        tr.clips.splice(idx, 1, parts[0], still, parts[1]);
        Player.releaseClip(clip.id);
      } else {
        // insert at edge: extend beyond
        const end = clip.start + clipDuration(clip);
        still.start = end;
        for (const x of tr.clips) if (x.start >= end - 0.001 && x.id !== clip.id) x.start += 1;
        tr.clips.push(still);
      }
      this.selectedClipId = still.id;
    });
    toast('Freeze frame added (1s) — trim to taste');
  }
  extractAudio(clip) {
    const media = mediaMap.get(clip.mediaId);
    if (!media) return;
    toast('Extracting audio…');
    extractAudioFromVideo(media).then(audioMedia => {
      saveMediaMeta(audioMedia);
      this.mutate('Extract audio', p => {
        const audioTrack = p.tracks.filter(t => t.kind === 'audio').pop();
        const ac = makeAudioClip(audioMedia, clip.start, clip.in, Math.min(clip.out, audioMedia.duration));
        audioTrack.clips.push(ac);
      });
      this.panels.refresh();
      toast('Audio extracted to audio track');
    }).catch(e => toast('Extract failed: ' + e.message));
  }

  applyRamp(clip, pattern) {
    this.mutate('Speed ramp', p => {
      const f = findClip(p, clip.id);
      if (!f) return;
      const tr = f.track;
      const idx = tr.clips.findIndex(c => c.id === clip.id);
      const srcLen = clip.out - clip.in;
      const segLen = srcLen / pattern.length;
      const newClips = [];
      let start = clip.start;
      for (let i = 0; i < pattern.length; i++) {
        const seg = deepClone(clip);
        seg.id = uid();
        seg.in = clip.in + i * segLen;
        seg.out = clip.in + (i + 1) * segLen;
        seg.speed = pattern[i];
        seg.start = start;
        start += segLen / pattern[i];
        if (i > 0) seg.effects = [];
        newClips.push(seg);
      }
      tr.clips.splice(idx, 1, ...newClips);
      Player.releaseClip(clip.id);
      this.selectedClipId = newClips[newClips.length - 1].id;
    });
    toast(`Ramp applied: ${pattern.join(' → ')}`);
  }

  snapCutsToMarkers() {
    this.mutate('Snap cuts to beats', p => {
      if (!p.markers.length) { toast('No beat markers — add some first'); return; }
      let n = 0;
      for (const tr of p.tracks) {
        if (tr.kind !== 'video' && tr.kind !== 'audio') continue;
        for (const c of tr.clips) {
          const end = c.start + clipDuration(c);
          let best = null, bestD = 0.3;
          for (const m of p.markers) {
            if (Math.abs(m - c.start) < bestD) { best = { v: m }; bestD = Math.abs(m - c.start); }
            else if (Math.abs(m - end) < bestD) { best = { v: m - clipDuration(c) }; bestD = Math.abs(m - end); }
          }
          if (best) { c.start = Math.max(0, best.v); n++; }
        }
      }
      toast(n ? `Snapped ${n} clip edges to beats` : 'No edges within 0.3s of a marker');
    });
  }
  splitAtMarkers() {
    this.mutate('Split at beats', p => {
      let n = 0;
      for (const tr of p.tracks) {
        if (tr.kind !== 'video') continue;
        for (const clip of [...tr.clips]) {
          for (const m of p.markers) {
            const cur = tr.clips.find(c => c.id === clip.id);
            if (!cur) break;
            if (m > cur.start + 0.15 && m < cur.start + clipDuration(cur) - 0.15) {
              const parts = splitClip(cur, m);
              if (parts) {
                const idx = tr.clips.findIndex(c => c.id === clip.id);
                tr.clips.splice(idx, 1, parts[0], parts[1]);
                Player.releaseClip(clip.id);
                n++;
              }
            }
          }
        }
      }
      toast(n ? `Split at ${n} beat points` : 'Nothing to split (clips already aligned or no markers)');
    });
  }
  autoMontage() {
    const p = this.project;
    if (!p.markers.length) { toast('Add beat markers first (tap pad or auto-detect)'); return; }
    const lib = [...mediaMap.values()].filter(m => m.kind === 'video' && m.duration > 0.6);
    if (!lib.length) { toast('Import some gameplay clips first'); return; }
    confirmDlg(`Build a beat-synced kill montage on "Video 1" using ${lib.length} library clip(s) and ${p.markers.length} beats?`, () => {
      this.mutate('Auto montage', pr => {
        for (const tr of pr.tracks) if (tr.kind === 'video') for (const c of tr.clips) Player.releaseClip(c.id);
        const vt = pr.tracks.find(t => t.kind === 'video');
        vt.clips = [];
        const patterns = [1, 1, 0.5, 2, 1, 0.25, 1.5];
        const markerList = [...pr.markers];
        const end = Math.min(projectDuration(pr), markerList[markerList.length - 1] + 2);
        let mi = 0;
        let t = 0;
        let li = 0;
        while (t < end - 0.2) {
          const nextM = markerList.find(m => m > t + 0.35);
          const segEnd = Math.min(nextM !== undefined ? nextM : end, t + 3);
          const dur = segEnd - t;
          if (dur < 0.25) { t = segEnd; mi++; continue; }
          const media = lib[li % lib.length]; li++;
          const speed = patterns[mi % patterns.length];
          const srcLen = Math.min(dur * speed, media.duration * 0.8);
          const c = makeVideoClip(media, t, 0.1 + (mi % 4) * 0.3, 0.1 + (mi % 4) * 0.3 + srcLen);
          c.speed = speed;
          vt.clips.push(c);
          t = segEnd; mi++;
        }
      });
      this.timeline.layout();
      this.player.seek(0);
      toast('Montage built — play it back and tweak!');
    }, 'Build');
  }

  addTrack(kind) {
    this.mutate('Add track', p => {
      const count = p.tracks.filter(t => t.kind === kind).length + 1;
      p.tracks.push({ id: uid(), kind, name: (kind === 'video' ? 'Video ' : 'Audio ') + count, muted: false, hidden: false, clips: [], transitions: {} });
    });
    toast((kind === 'video' ? 'Video layer' : 'Audio track') + ' added');
  }
  trackHeaderMenu(trackId) {
    const tr = this.project.tracks.find(t => t.id === trackId);
    if (!tr) return;
    const body = el('div', { class: 'stack' },
      toggle('Mute track', tr.muted, v => { this.mutate('Mute track', p => { const t = p.tracks.find(x => x.id === trackId); t.muted = v; }); }),
      tr.kind !== 'audio' ? toggle('Hide track', tr.hidden, v => { this.mutate('Hide track', p => { const t = p.tracks.find(x => x.id === trackId); t.hidden = v; }); }) : el('span'),
      tr.kind === 'video' ? el('button', { class: 'btn', onclick: () => { this.reverseTrack(tr); } }, 'Reverse clip order') : el('span'),
    );
    openModal({
      title: tr.name, body,
      actions: [
        {
          label: 'Delete track', kind: 'danger', onclick: () => {
            if (this.project.tracks.filter(t => t.kind === tr.kind).length <= 1) { toast('Keep at least one ' + tr.kind + ' track'); return; }
            this.mutate('Delete track', p => { p.tracks = p.tracks.filter(t => t.id !== trackId); });
          },
        },
        { label: 'Close', kind: 'ghost' },
      ],
    });
  }
  reverseTrack(tr) {
    this.mutate('Reverse order', p => {
      const t = p.tracks.find(x => x.id === tr.id);
      const sorted = clipsSorted(t);
      let t0 = sorted.length ? sorted[0].start : 0;
      for (const c of sorted.reverse()) { c.start = t0; t0 += clipDuration(c); }
    });
  }

  /* text/overlay quick adds */
  addTextPreset(kind) {
    const presets = {
      TITLE: () => { const c = makeTextClip(this.player.t, 3, 'YOUR TITLE'); c.font = 'Orbitron'; c.size = 10; c.glow = { on: true, color: '#00e5ff', strength: 1.2 }; c.letterSpacing = 4; return c; },
      SUBTITLE: () => { const c = makeTextClip(this.player.t, 3, 'Subtitle text'); c.size = 5; c.y = 0.85; c.bg = { on: true, color: '#0a0f1e', opacity: 0.6, pad: 0.4, radius: 8 }; return c; },
      KILL: () => { const c = makeTextClip(this.player.t, 1.5, 'ELIMINATED'); c.font = 'Bebas Neue'; c.size = 12; c.color = '#ff3355'; c.glow = { on: true, color: '#ff3355', strength: 1.4 }; c.y = 0.25; c.anim.in = 'pop'; c.anim.out = 'fade'; return c; },
      USERNAME: () => { const c = makeTextClip(this.player.t, 4, '@YOURTAG'); c.font = 'Chakra Petch'; c.size = 4.5; c.color = '#b388ff'; c.y = 0.92; c.x = 0.08; c.align = 'left'; c.anim.in = 'slide'; c.anim.dir = 'left'; return c; },
      CAPTION: () => { const c = makeTextClip(this.player.t, 2.5, 'caption line here'); c.size = 4; c.y = 0.88; c.bg = { on: true, color: '#000000', opacity: 0.75, pad: 0.45, radius: 6 }; c.anim.in = 'typewriter'; return c; },
    };
    const clip = presets[kind]();
    this.mutate('Add text', p => {
      const tr = p.tracks.find(t => t.kind === 'text');
      tr.clips.push(clip);
      this.selectedClipId = clip.id;
    });
    textEditor(this.api(), clip);
  }
  addOverlayPreset(sub) {
    const defs = {
      frame: { p: { color: '#00e5ff' } },
      lowerthird: { p: { color: '#00e5ff', text: 'PLAYER', sub: 'TRALIX EDITOR' } },
      rec: { p: { color: '#ff3355' } },
      killfeed: { p: { color: '#ff3355', interval: 1.6 } },
      xp: { p: { text: '+100 XP', interval: 1.2 } },
      counter: { p: { prefix: 'KILLS', start: 0, per: 1, color: '#00e5ff' } },
      vs: { p: { text: 'VS', color: '#00e5ff' } },
    };
    const clip = makeOverlayClip(sub, this.player.t, 4, defs[sub].p);
    this.mutate('Add overlay', p => {
      const tr = p.tracks.find(t => t.kind === 'overlay');
      tr.clips.push(clip);
      this.selectedClipId = clip.id;
    });
    toast('Overlay added at playhead');
  }

  /* AI tools */
  async removeSilence(clip) {
    const media = mediaMap.get(clip.mediaId);
    toast('Analyzing audio…');
    const buf = await getAudioBuffer(media);
    if (!buf) { toast('No audio to analyze'); return; }
    const ranges = analyzeSilence(buf, { threshDb: -38, minDur: 0.35 });
    if (!ranges.length) { toast('No silence found (threshold -38dB)'); return; }
    const toTimeline = srcT => clip.start + (srcT - clip.in) / (clip.speed || 1);
    const cuts = ranges.map(r => [toTimeline(r[0]), toTimeline(r[1])]).filter(([a, b]) => b > a + 0.12);
    confirmDlg(`Found ${cuts.length} silent section(s). Remove them from the timeline (cuts video & audio)?`, () => {
      this.mutate('Remove silence', p => {
        let shift = 0;
        for (const [a, b] of cuts) {
          const f = findClip(p, clip.id);
          if (!f) break;
          const startA = a - shift, endB = b - shift;
          const parts1 = splitClip(f.clip, startA);
          if (!parts1) continue;
          const tr = f.track;
          let idx = tr.clips.findIndex(c => c.id === clip.id);
          tr.clips.splice(idx, 1, parts1[0], parts1[1]);
          Player.releaseClip(clip.id);
          const parts2 = splitClip(parts1[1], endB);
          if (!parts2) continue;
          idx = tr.clips.findIndex(c => c.id === parts1[1].id);
          tr.clips.splice(idx, 1, parts2[0], parts2[1]);
          // delete the middle (silent) piece
          const midId = parts1[1].id;
          const mid = tr.clips.find(c => c.id === midId);
          const midDur = clipDuration(mid);
          tr.clips = tr.clips.filter(c => c.id !== midId);
          Player.releaseClip(midId);
          for (const c of tr.clips) if (c.start >= mid.start) c.start -= midDur;
          shift += midDur;
        }
      });
      toast('Silence removed');
    }, 'Remove');
  }
  async sceneDetect(clip) {
    const media = mediaMap.get(clip.mediaId);
    if (!media) return;
    const m = openModal({ title: 'Scene Detection', body: el('div', { class: 'hint' }, 'Scanning frames…'), actions: [] });
    try {
      const cuts = await detectScenes(media, { maxSamples: 48, onProgress: pr => { m.bodyEl.firstChild.textContent = `Scanning frames… ${Math.round(pr * 100)}%`; } });
      m.close();
      if (!cuts.length) { toast('No clear scene changes found'); return; }
      const toT = srcT => clip.start + (srcT - clip.in) / (clip.speed || 1);
      const list = el('div', { class: 'stack' },
        el('div', { class: 'hint' }, `${cuts.length} scene changes found:`),
        el('div', { class: 'chip-wrap' }, ...cuts.map(t => el('span', { class: 'chip' }, fmtTime(toT(t))))),
        el('div', { class: 'hint' }, 'Split the clip at these points?'));
      openModal({
        title: `Scene Detection — ${cuts.length} cuts`, body: list,
        actions: [
          {
            label: 'Split', kind: 'primary', onclick: () => {
              this.mutate('Scene split', p => {
                const tr = p.tracks.find(t => t.id === (findClip(p, clip.id)?.track.id));
                if (!tr) return;
                for (const srcT of cuts) {
                  const cur = tr.clips.find(c => c.id === clip.id);
                  if (!cur) break;
                  const tT = toT(srcT);
                  if (tT > cur.start + 0.2 && tT < cur.start + clipDuration(cur) - 0.2) {
                    const parts = splitClip(cur, tT);
                    if (parts) {
                      const idx = tr.clips.findIndex(c => c.id === clip.id);
                      tr.clips.splice(idx, 1, parts[0], parts[1]);
                      Player.releaseClip(clip.id);
                    }
                  }
                }
              });
              toast('Split at scene changes');
            },
          },
          { label: 'Cancel', kind: 'ghost' },
        ],
      });
    } catch (e) {
      m.close();
      toast('Scene detection failed: ' + e.message);
    }
  }
  async autoHighlights() {
    const p = this.project;
    // use first audio clip with decoded audio
    let src = null, media = null;
    for (const tr of p.tracks) {
      if (tr.kind !== 'audio') continue;
      for (const c of tr.clips) { const mm = mediaMap.get(c.mediaId); if (mm) { src = c; media = mm; break; } }
      if (src) break;
    }
    if (!src) { toast('Add music or an audio clip first'); return; }
    toast('Finding the loudest moments…');
    const buf = await getAudioBuffer(media);
    if (!buf) { toast('No audio to analyze'); return; }
    const toT = srcT => src.start + (srcT - src.in) / (src.speed || 1);
    const times = findHighlights(buf, 10).map(toT).filter(t => t >= 0 && t <= projectDuration(p));
    if (!times.length) { toast('No highlights found'); return; }
    const list = el('div', { class: 'stack' },
      el('div', { class: 'hint' }, `${times.length} highlight moments (energy peaks — likely kills/action):`),
      el('div', { class: 'chip-wrap' }, ...times.map(t => el('span', { class: 'chip' }, fmtTime(t)))),
    );
    openModal({
      title: 'Smart Highlights', body: list,
      actions: [
        {
          label: 'Add as beat markers', kind: 'primary', onclick: () => {
            this.mutate('Highlight markers', pr => {
              const set = new Set(pr.markers);
              for (const t of times) set.add(t);
              pr.markers = [...set].sort((a, b) => a - b);
            });
            toast('Highlights added as markers');
          },
        },
        { label: 'Close', kind: 'ghost' },
      ],
    });
  }

  /* Auto caption timing: distribute a pasted script across detected speech segments */
  async autoCaptions() {
    // pick the audio source with speech (first audio clip)
    let src = null, media = null;
    for (const tr of this.project.tracks) {
      if (tr.kind !== 'audio') continue;
      for (const c of tr.clips) { const mm = mediaMap.get(c.mediaId); if (mm) { src = c; media = mm; break; } }
      if (src) break;
    }
    const taHost = el('div', { class: 'stack' },
      el('div', { class: 'hint' }, src
        ? 'Paste (or type) what is said in the audio — lines are timed automatically onto detected speech segments and added as caption text clips.'
        : 'No audio clip found — captions will be timed evenly. Add music/voice-over for speech-based timing.'),
      (() => { const t = el('textarea', { class: 'input ta', rows: 5, placeholder: 'One caption line per line…\nLike this.\nGG, easy clamp.' }); t.dataset.role = 'script'; return t; })(),
    );
    openModal({
      title: 'Auto Caption Timing', body: taHost, width: 480,
      actions: [
        {
          label: 'Generate captions', kind: 'primary', onclick: async () => {
            const text = taHost.querySelector('textarea').value.trim();
            if (!text) return toast('Type the caption lines first');
            const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
            if (!lines.length) return;
            let segments = null;
            if (src && media) {
              const buf = await getAudioBuffer(media);
              if (buf) {
                const toT = st => src.start + (st - src.in) / (src.speed || 1);
                // speech = inverse of silence
                const silence = analyzeSilence(buf, { threshDb: -40, minDur: 0.3 });
                const dur = Math.min(buf.duration, src.out - src.in) / (src.speed || 1);
                const speech = [];
                let cursor = 0;
                for (const [a, b] of silence) {
                  if (a - cursor > 0.25) speech.push([toT(cursor), toT(a)]);
                  cursor = b;
                }
                if (dur - cursor > 0.25) speech.push([toT(cursor), toT(dur)]);
                segments = speech;
              }
            }
            // one time slot per line: walk speech ranges, allocating time proportional to line length
            const ranges = segments && segments.length ? segments : [[0.2, Math.max(2, projectDuration(this.project) - 0.2)]];
            const totalSpeech = ranges.reduce((s, [a, b]) => s + (b - a), 0);
            const sumLens = lines.reduce((s, l) => s + Math.max(4, l.length), 0);
            const slots = [];
            let ri = 0, pos = ranges[0][0];
            for (const line of lines) {
              let need = totalSpeech * (Math.max(4, line.length) / sumLens);
              let guard = 0;
              while (need > 0.001 && ri < ranges.length && guard++ < 200) {
                const [a, b] = ranges[ri];
                pos = Math.max(pos, a);
                const take = Math.min(Math.max(0, b - pos), need);
                if (take > 0.15) slots.push([pos, pos + take]);
                pos += take; need -= take;
                if (pos >= b - 0.001) { ri++; if (ri < ranges.length) pos = ranges[ri][0]; }
              }
              if (ri >= ranges.length && slots.length < lines.length) {
                // speech ran out: pad remaining lines evenly after the last slot
                const lastEnd = slots.length ? slots[slots.length - 1][1] : ranges[ranges.length - 1][1];
                for (let k = slots.length; k < lines.length; k++) {
                  const a = lastEnd + (k - slots.length) * 1.8;
                  slots.push([a, a + 1.6]);
                }
                break;
              }
            }
            this.mutate('Auto captions', p => {
              const tr = p.tracks.find(t => t.kind === 'text');
              lines.forEach((line, i) => {
                const [a, b] = slots[i] || [0.2 + i * 1.8, 0.2 + i * 1.8 + 1.6];
                const c = makeTextClip(Math.max(0, a), Math.max(0.6, b - a), line);
                c.size = 4.2; c.y = 0.88;
                c.bg = { on: true, color: '#000000', opacity: 0.72, pad: 0.45, radius: 6 };
                c.anim = { in: 'fade', out: 'fade', dur: 0.18, dir: 'up' };
                tr.clips.push(c);
              });
            });
            toast(`Timed ${lines.length} caption line(s) to speech`);
          },
        },
        { label: 'Cancel', kind: 'ghost' },
      ],
    });
  }

  /* ---------------- playback ui ---------------- */
  onFrame(t, playing) {
    this.timeline.updatePlayhead(t);
    this.timeLabel.textContent = `${fmtTime(t, true)} / ${fmtTime(projectDuration(this.project))}`;
    this.playBtn.textContent = playing ? '⏸' : '▶';
  }

  goBack() {
    this.player.pause();
    window.removeEventListener('keydown', this._keyHandler);
    this.save(true);
    this.app.showHome();
  }

  async save(final = false) {
    try {
      // thumbnail
      let thumb = null;
      try {
        const c = document.createElement('canvas');
        c.width = 320; c.height = Math.round(320 * this.project.height / this.project.width);
        drawFrame(c, this.project, Math.min(this.player.t, projectDuration(this.project) - 0.01));
        thumb = c.toDataURL('image/jpeg', 0.6);
      } catch { }
      for (const rec of mediaMap.values()) saveMediaMeta(rec);
      await idb.put('projects', {
        id: this.project.id,
        name: this.project.name,
        state: JSON.stringify({ ...this.project }),
        updatedAt: Date.now(),
        duration: projectDuration(this.project),
        thumb,
      });
      if (final) toast('Project saved');
    } catch (e) {
      console.warn('save failed', e);
    }
  }
}
