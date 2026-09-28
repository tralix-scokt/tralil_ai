/* TRALIX EDITOR — bottom tool panels: Media, Audio, Text, Effects, Adjust, Transitions */
import { el, toast, fmtDur, fmtTime, clamp, fmtBytes } from './util.js';
import { mediaMap, importFiles, saveMediaMeta, extractAudioFromVideo, deleteMedia, getAudioBuffer, peekAudioBuffer } from './media.js';
import { audioEngine, analyzeSilence } from './audio.js';
import { findClip, clipDuration, clipsSorted, makeVideoClip, makeAudioClip, makeTextClip, makeOverlayClip, DEFAULT_ADJ } from './model.js';
import { uid } from './util.js';
import { FX, FX_PRESETS, GRADE_PRESETS, TRANSITIONS } from './fx.js';
import {
  openModal, confirmDlg, slider, segButtons, textEditor, speedEditor,
  volumeEditor, beatSyncStudio,
} from './dialogs.js';

export class Panels {
  constructor(editor) {
    this.editor = editor;
    this.host = editor.panelHost;
    this.current = null;
    this.currentBtn = null;
    // close on outside tap
    this.host.addEventListener('pointerdown', e => e.stopPropagation());
  }

  toggle(tab, btn) {
    if (this.current === tab) { this.close(); return; }
    this.current = tab;
    this.currentBtn = btn || this.editor.tabbar.querySelector(`[data-tab="${tab}"]`);
    this.editor.tabbar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('on'));
    if (this.currentBtn) this.currentBtn.classList.add('on');
    this.render();
    this.host.classList.add('open');
  }
  open(tab) { this.toggle(tab); }
  close() {
    this.current = null;
    this.host.classList.remove('open');
    this.editor.tabbar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('on'));
  }
  refresh() { if (this.current) this.render(); }

  render() {
    this.host.innerHTML = '';
    const builders = {
      media: () => this.mediaPanel(),
      audio: () => this.audioPanel(),
      text: () => this.textPanel(),
      effects: () => this.effectsPanel(),
      adjust: () => this.adjustPanel(),
      trans: () => this.transitionsPanel(),
      export: () => { this.close(); import('./export.js').then(m => m.openExportFlow(this.editor.api())); },
    };
    const head = el('div', { class: 'panel-head' },
      el('div', { class: 'panel-title' }, (this.current || '').toUpperCase()),
      el('button', { class: 'icon-btn', onclick: () => this.close() }, '⌄'));
    const content = builders[this.current]();
    this.host.append(head, content);
  }

  sel() { return this.editor.sel(); }

  /* ================= MEDIA ================= */
  mediaPanel() {
    const ed = this.editor;
    const grid = el('div', { class: 'media-grid' });
    const rebuild = () => {
      grid.innerHTML = '';
      const items = [...mediaMap.values()].sort((a, b) => b.addedAt - a.addedAt);
      if (!items.length) {
        grid.append(el('div', { class: 'hint pad' }, 'No media yet — import your CODM clips.'));
      }
      for (const m of items) {
        const card = el('div', { class: 'media-card' + (m.kind === 'audio' ? ' audio' : '') });
        if (m.thumb) card.style.backgroundImage = `url(${m.thumb})`;
        card.append(
          el('div', { class: 'media-dur' }, m.kind === 'video' ? fmtDur(m.duration) : '🎵 ' + fmtDur(m.duration)),
          m.kind === 'video' ? el('div', { class: 'media-res' }, `${m.width}×${m.height} · ${Math.round(m.fps)}fps`) : el('div', { class: 'media-res' }, 'audio'),
          el('div', { class: 'media-name' }, m.name),
        );
        card.addEventListener('click', () => this.insertMedia(m));
        card.addEventListener('contextmenu', e => { e.preventDefault(); this.mediaMenu(m, rebuild); });
        const more = el('button', { class: 'media-more', onclick: e => { e.stopPropagation(); this.mediaMenu(m, rebuild); } }, '⋯');
        card.append(more);
        grid.append(card);
      }
    };
    rebuild();
    const input = el('input', { type: 'file', accept: 'video/*,audio/*', multiple: true, style: { display: 'none' } });
    input.addEventListener('change', async () => {
      if (!input.files.length) return;
      await this.editor.app.importIntoProject(ed, input.files);
      input.value = '';
      rebuild();
    });
    const prog = el('div', { class: 'hint' }, '');
    return el('div', { class: 'panel-body' },
      el('div', { class: 'row2' },
        el('button', {
          class: 'btn primary grow', onclick: () => input.click(),
        }, '📥 Import videos / music'),
        el('button', { class: 'btn', onclick: () => confirmDlg('Clear timeline and rebuild automatically as a beat montage?', () => ed.autoMontage(), 'Build') }, '⚡ Montage'),
      ),
      prog, input,
      grid,
      el('div', { class: 'hint pad' }, 'Tap = insert at playhead · ⋯ = more options. Files stay on your device.'),
    );
  }

  mediaMenu(m, rebuild) {
    const ed = this.editor;
    const body = el('div', { class: 'stack' });
    const modal = openModal({ title: 'Media Options', body, actions: [{ label: 'Close', kind: 'ghost' }] });
    const act = fn => () => { modal.close(); setTimeout(fn, 120); };
    if (m.kind === 'video') {
      body.append(
        el('button', { class: 'btn', onclick: act(() => { this.previewMedia(m); }) }, '▶ Preview'),
        el('button', { class: 'btn', onclick: act(() => { this.insertMedia(m, true); }) }, '↧ Add to new video layer'),
        el('button', {
          class: 'btn', onclick: act(async () => {
            try {
              const am = await extractAudioFromVideo(m);
              saveMediaMeta(am);
              ed.mutate('Insert audio', p => { p.tracks.filter(t => t.kind === 'audio').pop().clips.push(makeAudioClip(am, ed.player.t)); });
              this.refresh(); toast('Audio extracted to audio track');
            } catch (e) { toast('No decodable audio: ' + e.message); }
          }),
        }, '🎵 Extract audio → timeline'),
        el('button', { class: 'btn', onclick: act(() => { const f = this.sel(); f && f.clip.kind === 'video' ? ed.sceneDetect(f.clip) : toast('Select a video clip first'); }) }, '🧠 AI: Scene detection (selected clip)'),
      );
    } else {
      body.append(el('button', { class: 'btn', onclick: act(() => { this.insertMedia(m); }) }, '↧ Insert at playhead'));
    }
    body.append(
      el('div', { class: 'hint' }, `${m.name} — ${m.kind}${m.width ? `, ${m.width}×${m.height}` : ''}${m.fps ? `, ${Math.round(m.fps)} fps` : ''}, ${fmtDur(m.duration || 0)}, ${fmtBytes(m.size)}`),
      el('button', {
        class: 'btn danger', onclick: () => {
          modal.close();
          confirmDlg('Remove from media library? (Projects using it will show "media offline")', async () => {
            await deleteMedia(m.id); rebuild();
          }, 'Remove');
        },
      }, '🗑 Remove from library'),
    );
  }

  previewMedia(m) {
    const v = el('video', { controls: '', playsInline: '', style: { width: '100%', maxHeight: '50vh', background: '#000' } });
    openModal({
      title: m.name, body: v, pad: false,
      actions: [{ label: 'Close', kind: 'ghost', onclick: () => v.pause() }],
    });
    (async () => { try { v.src = await (await import('./media.js')).urlReady(m); v.play().catch(() => { }); } catch { } })();
  }

  insertMedia(m, newLayer = false) {
    const ed = this.editor;
    const t = ed.player.t;
    ed.mutate('Insert media', p => {
      let track = null;
      if (m.kind === 'video') {
        if (newLayer) {
          const count = p.tracks.filter(x => x.kind === 'video').length + 1;
          track = { id: uid(), kind: 'video', name: 'Video ' + count, muted: false, hidden: false, clips: [], transitions: {} };
          p.tracks.push(track);
        } else {
          track = p.tracks.find(x => x.kind === 'video');
        }
        const clip = makeVideoClip(m, t);
        this.pushClipsRight(track, t, clipDuration(clip));
        track.clips.push(clip);
        ed.selectedClipId = clip.id;
      } else {
        track = p.tracks.filter(x => x.kind === 'audio').pop();
        const clip = makeAudioClip(m, t);
        this.pushClipsRight(track, t, clipDuration(clip));
        track.clips.push(clip);
        ed.selectedClipId = clip.id;
      }
    });
    ed.renderActionBar();
    ed.player.requestDraw();
  }
  pushClipsRight(track, fromT, dur) {
    for (const c of track.clips) if (c.start + clipDuration(c) > fromT + 0.001 && c.start < fromT + dur) {
      // only push clips that would be overlapped starting at fromT
      if (c.start >= fromT - 0.001) c.start += dur;
    }
  }

  /* ================= AUDIO ================= */
  audioPanel() {
    const ed = this.editor;
    const body = el('div', { class: 'panel-body stack' });

    const musicInput = el('input', { type: 'file', accept: 'audio/*', style: { display: 'none' } });
    musicInput.addEventListener('change', async () => {
      if (!musicInput.files.length) return;
      const recs = await importFiles(musicInput.files);
      if (recs.length) {
        ed.mutate('Add music', p => {
          const tr = p.tracks.filter(x => x.kind === 'audio').pop();
          let t = ed.player.t;
          for (const r of recs) {
            const c = makeAudioClip(r, t);
            tr.clips.push(c);
            t += clipDuration(c);
          }
        });
        toast('Music added — open Beat Sync to lock cuts to the beat');
      }
      musicInput.value = '';
      this.refresh();
    });

    const recBtn = el('button', { class: 'btn' }, '🎙 Record voice-over');
    let recording = false, recIv = null, recStart = 0;
    recBtn.addEventListener('click', async () => {
      if (!recording) {
        try {
          await audioEngine.startRecording();
          recording = true; recStart = Date.now();
          recBtn.classList.add('danger'); recBtn.textContent = '⏹ Stop recording (0s)';
          recIv = setInterval(() => { recBtn.textContent = `⏹ Stop recording (${Math.floor((Date.now() - recStart) / 1000)}s)`; }, 500);
        } catch (e) { toast('Mic unavailable: ' + e.message); }
      } else {
        clearInterval(recIv);
        const blob = await audioEngine.stopRecording();
        recording = false; recBtn.classList.remove('danger'); recBtn.textContent = '🎙 Record voice-over';
        if (blob && blob.size) {
          const file = new File([blob], 'voiceover.webm', { type: blob.type });
          try {
            const rec = await (await import('./media.js')).ingestFile(file, { name: 'Voice-over ' + new Date().toLocaleTimeString() });
            saveMediaMeta(rec);
            ed.mutate('Voice-over', p => {
              p.tracks.filter(x => x.kind === 'audio').pop().clips.push(makeAudioClip(rec, ed.player.t));
            });
            this.refresh();
            toast('Voice-over added at playhead');
          } catch (e) { toast('Could not decode recording'); }
        }
      }
    });

    const sel = this.sel();
    body.append(
      el('div', { class: 'row2' },
        el('button', { class: 'btn primary grow', onclick: () => musicInput.click() }, '🎵 Add music'),
        musicInput,
        recBtn,
      ),
      el('button', { class: 'btn', onclick: () => beatSyncStudio(ed.api()) }, '🥁 Beat Sync Studio — markers, snap & auto montage'),
      el('button', { class: 'btn', onclick: () => ed.autoHighlights() }, '🧠 AI: Smart highlights (find action peaks)'),
      el('button', { class: 'btn', onclick: () => ed.autoCaptions() }, '🧠 AI: Auto caption timing (paste your script)'),
      el('button', {
        class: 'btn', onclick: () => {
          const f = this.sel();
          if (!f) return toast('Select a clip first');
          ed.removeSilence(f.clip);
        },
      }, '🧠 AI: Remove silent parts (selected clip)'),
      el('button', {
        class: 'btn', onclick: () => {
          const f = this.sel();
          if (!f || f.clip.kind !== 'video') return toast('Select a video clip first');
          ed.extractAudio(f.clip);
        },
      }, '✂ Separate original audio (selected video)'),
    );

    // audio track clips list
    const p = ed.project;
    const list = el('div', { class: 'stack' });
    for (const tr of p.tracks.filter(t => t.kind === 'audio')) {
      const clips = clipsSorted(tr);
      const row = el('div', { class: 'audio-track-row' },
        el('div', { class: 'field-label' }, `${tr.name}${tr.muted ? ' (muted)' : ''} — ${clips.length} clip(s)`));
      list.append(row);
      for (const c of clips) {
        const m = mediaMap.get(c.mediaId);
        const b = el('button', { class: 'btn small' }, `♪ ${m ? m.name : '?'} @ ${fmtTime(c.start)} · ${Math.round((c.volume ?? 1) * 100)}%`);
        b.addEventListener('click', () => { ed.selectClip && ed.selectClip(c.id); volumeEditor(ed.api(), c); });
        list.append(b);
      }
    }
    if (list.children.length) body.append(el('div', { class: 'field-label' }, 'Audio clips'), list);
    return body;
  }

  /* ================= AUTO CAPTIONS ================= */

  /* ================= TEXT & OVERLAYS ================= */
  textPanel() {
    const ed = this.editor;
    const body = el('div', { class: 'panel-body stack' });
    body.append(
      el('div', { class: 'field-label' }, 'Add text'),
      el('div', { class: 'preset-grid' },
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addTextPreset('TITLE'); } }, '🅣 Title'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addTextPreset('SUBTITLE'); } }, '≡ Subtitle'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addTextPreset('KILL'); } }, '☠ Kill notice'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addTextPreset('USERNAME'); } }, '@ Username'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addTextPreset('CAPTION'); } }, '💬 Caption'),
      ),
      el('div', { class: 'field-label' }, 'Gaming overlays'),
      el('div', { class: 'preset-grid' },
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addOverlayPreset('frame'); } }, '🖼 Neon frame'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addOverlayPreset('lowerthird'); } }, '▂ Lower third'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addOverlayPreset('rec'); } }, '⏺ REC'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addOverlayPreset('killfeed'); } }, '☠ Kill feed'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addOverlayPreset('xp'); } }, '✦ XP popup'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addOverlayPreset('counter'); } }, '# Kill counter'),
        el('button', { class: 'preset-btn', onclick: () => { this.close(); ed.addOverlayPreset('vs'); } }, '⚡ VS split'),
      ),
      el('div', { class: 'hint' }, 'Kill counter increments when the playhead passes beat markers — pair it with Beat Sync.'),
    );
    // existing text/overlay clips
    const p = ed.project;
    const items = [];
    for (const tr of p.tracks) {
      if (tr.kind !== 'text' && tr.kind !== 'overlay') continue;
      for (const c of tr.clips) items.push({ tr, c });
    }
    if (items.length) {
      const list = el('div', { class: 'stack' }, el('div', { class: 'field-label' }, 'On timeline'));
      for (const { tr, c } of items.sort((a, b) => a.c.start - b.c.start)) {
        const label = c.kind === 'text' ? `🅣 "${(c.text || '').slice(0, 18)}" @ ${fmtTime(c.start)}` : `▣ ${c.sub} @ ${fmtTime(c.start)}`;
        const row = el('div', { class: 'row2 tight' },
          el('button', {
            class: 'btn small grow', onclick: () => {
              ed.selectedClipId = c.id; ed.renderActionBar(); ed.timeline.select(c.id); ed.player.seek(c.start + 0.05);
            },
          }, label),
          el('button', { class: 'btn small', onclick: () => { c.kind === 'text' ? textEditor(ed.api(), c) : ed.overlayStyle(c); } }, '✎'),
          el('button', { class: 'btn small danger', onclick: () => ed.deleteClip(c) }, '🗑'));
        list.append(row);
      }
      body.append(list);
    }
    return body;
  }

  /* ================= EFFECTS ================= */
  effectsPanel() {
    const ed = this.editor;
    const found = this.sel();
    if (!found || !['video', 'still'].includes(found.clip.kind)) {
      return el('div', { class: 'panel-body' }, el('div', { class: 'hint pad' }, 'Select a video clip on the timeline to apply effects.'));
    }
    const clip = found.clip;
    ed.selectedClipId = clip.id;
    const body = el('div', { class: 'panel-body stack' });

    // presets
    body.append(el('div', { class: 'field-label' }, 'CODM presets'));
    body.append(el('div', { class: 'chip-wrap' },
      ...FX_PRESETS.map(pr => el('button', {
        class: 'chip', onclick: () => {
          ed.mutate('FX preset', p => {
            const f = findClip(p, clip.id); if (!f) return;
            const c = f.clip;
            c.adj = { ...DEFAULT_ADJ(), ...pr.adj };
            for (const fx of pr.fx) c.effects.push({ id: uid(), type: fx.type, p: { ...fx.p } });
          });
          ed.player.requestDraw();
          this.refresh();
          toast(`Preset "${pr.name}" applied`);
        },
      }, `${pr.icon} ${pr.name}`)),
    ));

    // effect toggles
    const has = type => (clip.effects || []).some(f => f.type === type);
    body.append(el('div', { class: 'field-label' }, 'Effects'));
    const grid = el('div', { class: 'chip-wrap' });
    for (const [type, def] of Object.entries(FX)) {
      if (type === 'blur') continue; // blur lives in Adjust
      const b = el('button', { class: 'chip' + (has(type) ? ' on' : '') }, `${def.icon} ${def.name}`);
      b.addEventListener('click', () => {
        if (has(type)) {
          ed.mutate('Remove FX', p => { const f = findClip(p, clip.id); f.clip.effects = f.clip.effects.filter(x => x.type !== type); });
        } else {
          const pDefault = {};
          for (const [k, v] of Object.entries(def.p || {})) pDefault[k] = v.def;
          ed.mutate('Add FX', p => { const f = findClip(p, clip.id); f.clip.effects.push({ id: uid(), type, p: pDefault }); });
        }
        this.refresh();
      });
      grid.append(b);
    }
    body.append(grid);

    // active effect params
    for (const fx of clip.effects || []) {
      const def = FX[fx.type];
      if (!def) continue;
      const box = el('div', { class: 'fx-box' });
      box.append(el('div', { class: 'fx-head' },
        el('span', {}, `${def.icon} ${def.name}`),
        el('div', { class: 'grow' }),
        el('button', { class: 'btn tiny', onclick: () => { const lt = ed.player.t - clip.start; ed.mutate('Burst window', p => { const f = findClip(p, clip.id).clip.effects.find(x => x.id === fx.id); if (!f) return; f.t0 = Math.max(0, lt - 0.25); f.t1 = lt + 0.45; }); toast('Effect bursts at playhead ±0.45s'); } }, '⧗ @ playhead'),
        el('button', { class: 'btn tiny', onclick: () => { ed.mutate('Whole clip FX', p => { const f = findClip(p, clip.id).clip.effects.find(x => x.id === fx.id); if (f) { delete f.t0; delete f.t1; } }); } }, '∞ whole'),
        el('button', { class: 'btn tiny danger', onclick: () => { ed.mutate('Remove FX', p => { const f = findClip(p, clip.id); f.clip.effects = f.clip.effects.filter(x => x.id !== fx.id); }); this.refresh(); } }, '✕'),
      ));
      const windowLabel = fx.t1 !== undefined && fx.t1 !== null
        ? `window ${fmtTime(fx.t0 || 0)}–${fmtTime(fx.t1)} (clip-local)`
        : 'whole clip';
      box.append(el('div', { class: 'hint' }, windowLabel));
      for (const [k, v] of Object.entries(def.p || {})) {
        if (v.type === 'color') {
          const ci = el('input', { type: 'color', value: fx.p[k] || v.def });
          ci.addEventListener('input', () => ed.mutateLive(() => { fx.p[k] = ci.value; }));
          box.append(el('div', { class: 'color-row' }, el('label', {}, v.label), ci));
        } else {
          box.append(slider(v.label, fx.p[k] ?? v.def, v.min, v.max, v.step, val => {
            ed.mutateLive(() => { fx.p[k] = val; });
          }, val => val.toFixed(2)));
        }
      }
      body.append(box);
    }
    return body;
  }

  /* ================= ADJUST (color grade) ================= */
  adjustPanel() {
    const ed = this.editor;
    const found = this.sel();
    if (!found || !['video', 'still'].includes(found.clip.kind)) {
      return el('div', { class: 'panel-body' }, el('div', { class: 'hint pad' }, 'Select a video clip to color grade it.'));
    }
    const clip = found.clip;
    if (!clip.adj) clip.adj = DEFAULT_ADJ();
    const body = el('div', { class: 'panel-body stack' });

    body.append(el('div', { class: 'field-label' }, 'Grade presets'));
    body.append(el('div', { class: 'chip-wrap' },
      ...GRADE_PRESETS.map(pr => el('button', {
        class: 'chip', onclick: () => {
          ed.mutate('Grade preset', p => {
            const c = findClip(p, clip.id).clip;
            c.adj = { ...DEFAULT_ADJ(), ...pr.adj };
          });
          ed.player.requestDraw();
          this.refresh();
          toast(`Grade "${pr.name}" applied`);
        },
      }, pr.name)),
    ));

    const defs = [
      ['brightness', 'Brightness', -1, 1, 0.02], ['contrast', 'Contrast', -1, 1.5, 0.02],
      ['saturation', 'Saturation', -1, 2, 0.02], ['exposure', 'Exposure', -1, 1, 0.02],
      ['highlights', 'Highlights', -1, 1, 0.02], ['shadows', 'Shadows', -1, 1, 0.02],
      ['temperature', 'Temperature', -1, 1, 0.02], ['tint', 'Tint', -1, 1, 0.02],
      ['sharpen', 'Sharpen', 0, 1, 0.02], ['fade', 'Fade', 0, 1, 0.02],
      ['vignette', 'Vignette', 0, 1, 0.02], ['blur', 'Blur', 0, 12, 0.2],
    ];
    for (const [key, label, min, max, step] of defs) {
      body.append(slider(label, clip.adj[key] ?? 0, min, max, step, v => {
        ed.mutateLive(() => { clip.adj[key] = v; });
      }, v => v.toFixed(2)));
    }
    body.append(el('button', {
      class: 'btn', onclick: () => {
        ed.mutate('Reset grade', p => { findClip(p, clip.id).clip.adj = DEFAULT_ADJ(); });
        this.refresh();
      },
    }, '↺ Reset all adjustments'));
    return body;
  }

  /* ================= TRANSITIONS ================= */
  transitionsPanel() {
    const ed = this.editor;
    const found = this.sel();
    if (!found || found.track.kind !== 'video') {
      return el('div', { class: 'panel-body' }, el('div', { class: 'hint pad' }, 'Select a video clip — the transition applies between it and the next clip.'));
    }
    const { track, clip } = found;
    const clips = clipsSorted(track);
    const idx = clips.findIndex(c => c.id === clip.id);
    const next = clips[idx + 1];
    if (!next) {
      return el('div', { class: 'panel-body' }, el('div', { class: 'hint pad' }, 'This clip has no following clip on its track. Split or add another clip to place a transition between them.'));
    }
    const cur = track.transitions[clip.id] || { type: 'none', dur: 0.3 };
    const boundary = clip.start + clipDuration(clip);

    const body = el('div', { class: 'panel-body stack' });
    body.append(el('div', { class: 'hint' }, `Transition at ${fmtTime(boundary)} — ${clip.start.toFixed(1)}s → ${next.start.toFixed(1)}s`));
    const grid = el('div', { class: 'chip-wrap' });
    for (const [type, def] of Object.entries(TRANSITIONS)) {
      const b = el('button', { class: 'chip' + (cur.type === type ? ' on' : '') }, `${def.icon} ${def.name}`);
      b.addEventListener('click', () => {
        ed.mutate('Transition', p => {
          const tr = p.tracks.find(t => t.id === track.id);
          if (type === 'none') delete tr.transitions[clip.id];
          else tr.transitions[clip.id] = { type, dur: cur.dur || 0.3 };
        });
        // preview: jump before boundary
        ed.player.seek(Math.max(0, boundary - 0.6));
        ed.player.play(Math.max(0, boundary - 0.6));
        this.refresh();
      });
      grid.append(b);
    }
    body.append(grid);
    body.append(slider('Duration', cur.dur || 0.3, 0.1, 2, 0.05, v => {
      ed.mutateLive(() => {
        const tr = ed.project.tracks.find(t => t.id === track.id);
        if (tr.transitions[clip.id]) tr.transitions[clip.id].dur = v;
      });
      ed.timeline.layout();
    }, v => v.toFixed(2) + 's'));
    body.append(el('div', { class: 'hint' }, 'Transitions overlap both clips (frames freeze at the edges if a clip has no extra media). No watermark, all free.'));
    return body;
  }
}
