/* TRALIX EDITOR — bottom tool panels (v2):
   Edit · Audio · Text · Overlay · Effects · Filters · Adjust · Transition · Canvas · Speed */
import { el, toast, fmtDur, fmtTime, clamp, fmtBytes } from './util.js';
import { uid } from './util.js';
import { mediaMap, importFiles, saveMediaMeta, extractAudioFromVideo, deleteMedia, getAudioBuffer } from './media.js';
import { audioEngine } from './audio.js';
import {
  findClip, clipDuration, clipsSorted, makeVideoClip, makeAudioClip, makeTextClip,
  makeOverlayClip, makeOverlayMediaClip, makeStillClip, DEFAULT_ADJ, CODM_TEMPLATES,
} from './model.js';
import { applyTemplate } from './home.js';
import { FX, FX_CATS, TRALIX_FILTERS, TRANSITIONS } from './fx.js';
import {
  openModal, confirmDlg, slider, segButtons, textEditor, speedEditor,
  volumeEditor, beatSyncStudio, trimDialog, animationDialog,
} from './dialogs.js';

export class Panels {
  constructor(editor) {
    this.editor = editor;
    this.host = editor.panelHost;
    this.current = null;
    this.host.addEventListener('pointerdown', e => e.stopPropagation());
  }

  toggle(tab, btn) {
    // modal-style tools
    if (tab === 'speed') {
      const f = this.editor.sel();
      if (!f) { toast('Select a clip first'); return; }
      if (!['video', 'audio', 'ovl'].includes(f.clip.kind)) { toast('Speed applies to video/audio clips'); return; }
      this.close();
      speedEditor(this.editor.api(), f.clip);
      return;
    }
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
      edit: () => this.editPanel(),
      audio: () => this.audioPanel(),
      text: () => this.textPanel(),
      overlay: () => this.overlayPanel(),
      effects: () => this.effectsPanel(),
      filters: () => this.filtersPanel(),
      adjust: () => this.adjustPanel(),
      trans: () => this.transitionsPanel(),
      canvas: () => this.canvasPanel(),
    };
    const head = el('div', { class: 'panel-head' },
      el('div', { class: 'panel-title' }, (this.current || '').toUpperCase()),
      el('button', { class: 'icon-btn', onclick: () => this.close() }, '⌄'));
    const content = builders[this.current]();
    this.host.append(head, content);
  }

  sel() { return this.editor.sel(); }
  needsClip(kinds, label) {
    const f = this.sel();
    if (!f || !kinds.includes(f.clip.kind)) {
      return el('div', { class: 'panel-body' },
        el('div', { class: 'hint pad' }, label || 'Select a video or overlay clip on the timeline first.'));
    }
    return null;
  }

  /* ================= EDIT (media browser / import) ================= */
  editPanel() {
    const ed = this.editor;
    const grid = el('div', { class: 'media-grid' });
    const rebuild = () => {
      grid.innerHTML = '';
      const items = [...mediaMap.values()].sort((a, b) => b.addedAt - a.addedAt);
      if (!items.length) grid.append(el('div', { class: 'hint pad' }, 'No media yet — import clips, photos or music.'));
      for (const m of items) {
        const card = el('div', { class: 'media-card' + (m.kind !== 'video' ? ' audio' : '') });
        if (m.thumb) card.style.backgroundImage = `url(${m.thumb})`;
        const badge = m.kind === 'video' ? fmtDur(m.duration)
          : m.kind === 'audio' ? '🎵 ' + fmtDur(m.duration) : '🖼 Photo';
        card.append(
          el('div', { class: 'media-dur' }, badge),
          m.kind === 'video' ? el('div', { class: 'media-res' }, `${m.width}×${m.height} · ${Math.round(m.fps)}fps`) : null,
          el('div', { class: 'media-name' }, m.name),
          el('button', { class: 'media-more', onclick: e => { e.stopPropagation(); this.mediaMenu(m, rebuild); } }, '⋯'),
        );
        card.addEventListener('click', () => this.insertMedia(m));
        grid.append(card);
      }
    };
    rebuild();

    const mkInput = (accept, label, cls) => {
      const input = el('input', { type: 'file', accept, multiple: true, style: { display: 'none' } });
      input.addEventListener('change', async () => {
        if (!input.files.length) return;
        await this.editor.app.importIntoProject(ed, input.files);
        input.value = '';
        rebuild();
      });
      return [el('button', { class: 'btn ' + cls, onclick: () => input.click() }, label), input];
    };
    const [vidBtn, vidIn] = mkInput('video/*', '🎞 Video', 'primary grow');
    const [phBtn, phIn] = mkInput('image/*', '🖼 Photo', 'grow');
    const [audBtn, audIn] = mkInput('audio/*', '🎵 Music', 'grow');
    const tplBtn = el('button', {
      class: 'btn warn', onclick: () => {
        const body = el('div', { class: 'preset-grid' },
          ...CODM_TEMPLATES.map(tpl => el('button', {
            class: 'preset-btn', onclick: () => {
              document.querySelectorAll('.modal-backdrop').forEach(m => m.remove());
              ed.mutate('Apply template', p => applyTemplate(p, tpl));
              ed.timeline.layout();
              ed.player.requestDraw();
              toast(`${tpl.name} template applied`);
            },
          }, `⚡ ${tpl.name}`)));
        openModal({ title: 'CODM Templates', body, actions: [{ label: 'Close', kind: 'ghost' }] });
      },
    }, '⚡ CODM Templates');
    const browseBtn = el('button', {
      class: 'btn', onclick: () => {
        const input = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
        input.addEventListener('change', async () => {
          if (!input.files.length) return;
          await this.editor.app.importIntoProject(ed, input.files);
          input.remove(); rebuild();
        });
        document.body.append(input);
        input.click();
      },
    }, '📂 Browse');
    browseBtn.style.flex = '0 0 auto';

    return el('div', { class: 'panel-body' },
      el('div', { class: 'row2' }, vidBtn, vidIn),
      el('div', { class: 'row2' }, phBtn, phIn, audBtn, audIn, browseBtn),
      tplBtn,
      grid,
      el('div', { class: 'hint pad' }, 'Tap = insert at playhead · ⋯ = options (main track, overlay, extract audio). Files stay on your device.'),
    );
  }

  mediaMenu(m, rebuild) {
    const ed = this.editor;
    const body = el('div', { class: 'stack' });
    const modal = openModal({ title: 'Media Options', body, actions: [{ label: 'Close', kind: 'ghost' }] });
    const act = fn => () => { modal.close(); setTimeout(fn, 120); };
    if (m.kind === 'video') {
      body.append(
        el('button', { class: 'btn', onclick: act(() => this.previewMedia(m)) }, '▶ Preview'),
        el('button', { class: 'btn', onclick: act(() => this.insertMedia(m)) }, '↧ Insert at playhead (main track)'),
        el('button', { class: 'btn', onclick: act(() => this.insertMedia(m, { asOverlay: true })) }, '⬒ Add as overlay (PiP)'),
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
    } else if (m.kind === 'image') {
      body.append(
        el('button', { class: 'btn', onclick: act(() => this.insertMedia(m, { asOverlay: true })) }, '⬒ Add as overlay (recommended)'),
        el('button', { class: 'btn', onclick: act(() => this.insertMedia(m, { main: true })) }, '↧ Add to main track (full frame)'),
      );
    } else {
      body.append(el('button', { class: 'btn', onclick: act(() => this.insertMedia(m)) }, '↧ Insert at playhead'));
    }
    body.append(
      el('div', { class: 'hint' }, `${m.name} — ${m.kind}${m.width ? `, ${m.width}×${m.height}` : ''}${m.fps ? `, ${Math.round(m.fps)} fps` : ''}, ${m.kind === 'image' ? '' : fmtDur(m.duration || 0) + ', '}${fmtBytes(m.size)}`),
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
    const holder = el('div', { style: { width: '100%', maxHeight: '50vh', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' } });
    openModal({ title: m.name, body: holder, pad: false, actions: [{ label: 'Close', kind: 'ghost' }] });
    (async () => {
      try {
        const { urlReady } = await import('./media.js');
        const url = await urlReady(m);
        if (m.kind === 'image') {
          holder.innerHTML = '';
          holder.append(el('img', { src: url, style: { maxWidth: '100%', maxHeight: '50vh' } }));
        } else {
          const v = el('video', { src: url, controls: '', playsInline: '', style: { width: '100%', maxHeight: '50vh', background: '#000' } });
          holder.innerHTML = '';
          holder.append(v);
          v.play().catch(() => { });
        }
      } catch { }
    })();
  }

  insertMedia(m, opts = {}) {
    const ed = this.editor;
    const t = ed.player.t;
    ed.mutate('Insert media', p => {
      if (m.kind === 'video' && !opts.asOverlay) {
        const track = p.tracks.find(x => x.kind === 'video');
        const clip = makeVideoClip(m, t);
        this.pushClipsRight(track, t, clipDuration(clip));
        track.clips.push(clip);
        ed.selectedClipId = clip.id;
      } else if (m.kind === 'image' && opts.main) {
        const track = p.tracks.find(x => x.kind === 'video');
        const clip = makeStillClip(m.thumb || '', t, 4);
        clip.mediaId = m.id; // full-res compositing via overlay image cache
        clip.kind = 'ovl'; clip.contain = false;
        clip.duration = 4;
        this.pushClipsRight(track, t, clipDuration(clip));
        track.clips.push(clip);
        ed.selectedClipId = clip.id;
      } else {
        // overlays: video or photo -> overlay track
        let track = p.tracks.find(x => x.kind === 'overlay');
        const clip = m.kind === 'image'
          ? (() => { const c = makeOverlayMediaClip(m, t); c.kind = 'ovl'; return c; })()
          : makeOverlayMediaClip(m, t);
        track.clips.push(clip);
        ed.selectedClipId = clip.id;
        ed.selectedTrackId = track.id;
      }
    });
    ed.renderActionBar();
    ed.player.requestDraw();
    this.refresh();
  }
  pushClipsRight(track, fromT, dur) {
    for (const c of track.clips) {
      if (c.start >= fromT - 0.001 && c.start < fromT + dur) c.start += dur;
    }
  }

  /* ================= AUDIO ================= */
  audioPanel() {
    const ed = this.editor;
    const body = el('div', { class: 'panel-body stack' });

    const musicInput = el('input', { type: 'file', accept: 'audio/*', multiple: true, style: { display: 'none' } });
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

    body.append(
      el('div', { class: 'row2' },
        el('button', { class: 'btn primary grow', onclick: () => musicInput.click() }, '🎵 Add music'),
        musicInput,
        recBtn,
      ),
      el('button', { class: 'btn', onclick: () => beatSyncStudio(ed.api()) }, '🥁 Beat Sync Studio — markers, snap & auto montage'),
      el('button', { class: 'btn', onclick: () => ed.autoHighlights() }, '🧠 AI: Smart highlights (find action peaks)'),
      el('button', { class: 'btn', onclick: () => ed.autoCaptions() }, '🄰 AI: Auto captions from script'),
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
      el('button', {
        class: 'btn', onclick: () => {
          const f = this.sel();
          if (!f || f.clip.kind !== 'video') return toast('Select a video clip first');
          ed.mutate('Mute original', p => { const c = findClip(p, f.clip.id); if (c) c.clip.muted = !c.clip.muted; });
          this.refresh();
          toast(f.clip.muted ? 'Original audio restored' : 'Original video audio muted');
        },
      }, '🔇 Mute / unmute original video audio'),
    );

    const p = ed.project;
    const list = el('div', { class: 'stack' });
    for (const tr of p.tracks.filter(t => t.kind === 'audio')) {
      const clips = clipsSorted(tr);
      list.append(el('div', { class: 'field-label' }, `${tr.name}${tr.muted ? ' (muted)' : ''} — ${clips.length} clip(s)`));
      for (const c of clips) {
        const m = mediaMap.get(c.mediaId);
        const b = el('button', { class: 'btn small' }, `♪ ${m ? m.name : '?'} @ ${fmtTime(c.start)} · ${Math.round((c.volume ?? 1) * 100)}%${c.reverse ? ' · reverse' : ''}`);
        b.addEventListener('click', () => volumeEditor(ed.api(), c));
        list.append(b);
      }
    }
    if (list.children.length) body.append(el('div', { class: 'field-label' }, 'Audio clips — tap for volume/fades'), list);
    return body;
  }

  /* ================= TEXT ================= */
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
      el('div', { class: 'hint' }, 'Tip: double-tap a text clip on the timeline to edit it.'),
    );
    const p = ed.project;
    const items = [];
    for (const tr of p.tracks) {
      if (tr.kind !== 'text' && tr.kind !== 'overlay') continue;
      for (const c of tr.clips) if (c.kind === 'text' || c.kind === 'overlay') items.push({ tr, c });
    }
    if (items.length) {
      const list = el('div', { class: 'stack' }, el('div', { class: 'field-label' }, 'On timeline'));
      for (const { tr, c } of items.sort((a, b) => a.c.start - b.c.start)) {
        const label = c.kind === 'text' ? `🅣 "${(c.text || '').slice(0, 18)}" @ ${fmtTime(c.start)}` : `▣ ${c.sub} @ ${fmtTime(c.start)}`;
        list.append(el('div', { class: 'row2 tight' },
          el('button', {
            class: 'btn small grow', onclick: () => {
              ed.selectedClipId = c.id; ed.renderActionBar(); ed.timeline.select(c.id); ed.player.seek(c.start + 0.05);
            },
          }, label),
          el('button', { class: 'btn small', onclick: () => { c.kind === 'text' ? textEditor(ed.api(), c) : ed.overlayStyle(c); } }, '✎'),
          el('button', { class: 'btn small danger', onclick: () => ed.deleteClip(c) }, '🗑')));
      }
      body.append(list);
    }
    return body;
  }

  /* ================= OVERLAY (media + gaming overlays) ================= */
  overlayPanel() {
    const ed = this.editor;
    const body = el('div', { class: 'panel-body stack' });

    // media overlays from library
    const media = [...mediaMap.values()].filter(m => m.kind === 'video' || m.kind === 'image');
    if (media.length) {
      body.append(el('div', { class: 'field-label' }, 'Add media overlay (photo / video PiP)'));
      const grid = el('div', { class: 'media-grid' });
      for (const m of media.slice(0, 12)) {
        const card = el('div', { class: 'media-card' + (m.kind !== 'video' ? ' audio' : '') });
        if (m.thumb) card.style.backgroundImage = `url(${m.thumb})`;
        card.append(el('div', { class: 'media-name' }, m.name));
        card.addEventListener('click', () => { this.insertMedia(m, { asOverlay: true }); this.close(); toast('Overlay added — drag it in the preview to position'); });
        grid.append(card);
      }
      body.append(grid);
    } else {
      body.append(el('div', { class: 'hint' }, 'Import photos or videos in the Edit tab, then add them here as overlays.'));
    }

    body.append(
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
    );

    // manage overlay clips
    const p = ed.project;
    const ovlTracks = p.tracks.filter(t => t.kind === 'overlay');
    const items = [];
    for (const tr of ovlTracks) for (const c of tr.clips) items.push({ tr, c });
    if (items.length) {
      const list = el('div', { class: 'stack' }, el('div', { class: 'field-label' }, 'Overlay layers (top drawn first)'));
      for (const { tr, c } of items.sort((a, b) => b.c.start - a.c.start)) {
        const m = c.mediaId ? mediaMap.get(c.mediaId) : null;
        const label = c.kind === 'ovl'
          ? `🖼 ${m ? m.name : 'media'} @ ${fmtTime(c.start)} · ${(c.opacity ?? 1 * 100) | 0}%`
          : `▣ ${c.sub} @ ${fmtTime(c.start)}`;
        list.append(el('div', { class: 'row2 tight' },
          el('button', {
            class: 'btn small grow', onclick: () => {
              ed.selectedClipId = c.id; ed.selectedTrackId = tr.id;
              ed.renderActionBar(); ed.timeline.select(c.id);
              ed.player.seek(c.start + 0.1);
              if (c.kind === 'ovl') { this.close(); toast('Drag / pinch it directly in the preview'); }
            },
          }, label),
          c.kind === 'ovl'
            ? el('button', { class: 'btn small', onclick: () => { this.close(); ed.overlayMediaStyle(c); } }, '⚙')
            : el('button', { class: 'btn small', onclick: () => ed.overlayStyle(c) }, '⚙'),
          el('button', { class: 'btn small danger', onclick: () => ed.deleteClip(c) }, '🗑')));
      }
      body.append(list);
    }
    body.append(el('div', { class: 'hint' }, 'Overlays composite above the main video in preview and in the exported file.'));
    return body;
  }

  /* ================= EFFECTS (TRALIX FX library) ================= */
  effectsPanel() {
    const ed = this.editor;
    const found = this.sel();
    const gate = this.needsClip(['video', 'still', 'ovl'], 'Select a video or overlay clip to apply TRALIX FX.');
    if (gate) return gate;
    const clip = found.clip;
    ed.selectedClipId = clip.id;
    const body = el('div', { class: 'panel-body stack' });

    // categorized library
    for (const [cat, def] of Object.entries(FX_CATS)) {
      body.append(el('div', { class: 'field-label' }, `${def.icon} ${def.label}`));
      const wrap = el('div', { class: 'chip-wrap' });
      for (const type of def.types) {
        const fxd = FX[type];
        if (!fxd) continue;
        const has = (clip.effects || []).some(f => f.type === type);
        const b = el('button', { class: 'chip' + (has ? ' on' : '') }, `${fxd.icon} ${fxd.name}`);
        b.addEventListener('click', () => {
          if (has) {
            ed.mutate('Remove FX', p => { const f = findClip(p, clip.id); f.clip.effects = f.clip.effects.filter(x => x.type !== type); });
          } else {
            const pDefault = {};
            for (const [k, v] of Object.entries(fxd.p || {})) pDefault[k] = v.def;
            ed.mutate('Add FX', p => { findClip(p, clip.id).clip.effects.push({ id: uid(), type, p: pDefault }); });
          }
          this.refresh();
        });
        wrap.append(b);
      }
      body.append(wrap);
    }

    // params of active effects
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
      box.append(el('div', { class: 'hint' }, fx.t1 !== undefined && fx.t1 !== null
        ? `window ${fmtTime(fx.t0 || 0)}–${fmtTime(fx.t1)} (clip-local)` : 'whole clip'));
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

  /* ================= FILTERS (TRALIX looks) ================= */
  filtersPanel() {
    const ed = this.editor;
    const gate = this.needsClip(['video', 'still', 'ovl'], 'Select a video or overlay clip to apply a TRALIX filter.');
    if (gate) return gate;
    const clip = this.sel().clip;
    const body = el('div', { class: 'panel-body stack' });

    let cat = 'all';
    const grid = el('div', { class: 'preset-grid' });
    const renderGrid = () => {
      grid.innerHTML = '';
      for (const f of TRALIX_FILTERS) {
        if (cat !== 'all' && f.cat !== cat) continue;
        const b = el('button', { class: 'preset-btn' }, `${f.icon || '🎨'} ${f.name}`);
        b.addEventListener('click', () => {
          ed.mutate('Filter', p => {
            const c = findClip(p, clip.id).clip;
            c.adj = { ...DEFAULT_ADJ(), ...f.adj };
            if (f.fx) {
              c.effects = (c.effects || []).filter(x => !f.fx.some(g => g.type === x.type));
              for (const g of f.fx) c.effects.push({ id: uid(), type: g.type, p: { ...g.p } });
            }
          });
          ed.player.requestDraw();
          toast(`Filter "${f.name}" applied`);
        });
        grid.append(b);
      }
    };
    const cats = el('div', { class: 'chip-wrap' },
      ...[['all', 'All'], ['gaming', '🎮 Gaming'], ['cinematic', '🎬 Cinematic'], ['dark', '🌑 Dark'], ['vibrant', '⚡ Vibrant'], ['anime', '🌸 Anime']]
        .map(([id, label]) => {
          const b = el('button', { class: 'chip' + (id === cat ? ' on' : '') }, label);
          b.addEventListener('click', () => {
            cat = id;
            cats.querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
            b.classList.add('on');
            renderGrid();
          });
          return b;
        }));
    body.append(cats);
    renderGrid();
    body.append(grid,
      el('button', {
        class: 'btn', onclick: () => {
          ed.mutate('Clear filter', p => { findClip(p, clip.id).clip.adj = DEFAULT_ADJ(); });
          this.refresh();
        },
      }, '↺ Remove filter (reset adjustments)'));
    return body;
  }

  /* ================= ADJUST ================= */
  adjustPanel() {
    const ed = this.editor;
    const gate = this.needsClip(['video', 'still', 'ovl'], 'Select a video or overlay clip to color grade it.');
    if (gate) return gate;
    const clip = this.sel().clip;
    if (!clip.adj) clip.adj = DEFAULT_ADJ();
    const body = el('div', { class: 'panel-body stack' });

    const defs = [
      ['brightness', 'Brightness', -1, 1, 0.02], ['contrast', 'Contrast', -1, 1.5, 0.02],
      ['saturation', 'Saturation', -1, 2, 0.02], ['exposure', 'Exposure', -1, 1, 0.02],
      ['highlights', 'Highlights', -1, 1, 0.02], ['shadows', 'Shadows', -1, 1, 0.02],
      ['temperature', 'Temperature', -1, 1, 0.02], ['tint', 'Tint', -1, 1, 0.02],
      ['sharpen', 'Sharpen', 0, 1, 0.02], ['fade', 'Fade', 0, 1, 0.02],
      ['vignette', 'Vignette', 0, 1, 0.02], ['grain', 'Grain', 0, 1, 0.02],
      ['blur', 'Blur', 0, 12, 0.2],
    ];
    for (const [key, label, min, max, step] of defs) {
      if (key === 'grain') {
        // grain via FX so it animates
        const fx = (clip.effects || []).find(f => f.type === 'grain');
        const val = fx ? fx.p.amount : 0;
        body.append(slider(label, val, min, max, step, v => {
          ed.mutateLive(() => {
            let f = (clip.effects || []).find(x => x.type === 'grain');
            if (v <= 0.01) {
              if (f) clip.effects = clip.effects.filter(x => x.type !== 'grain');
              return;
            }
            if (!f) { f = { id: uid(), type: 'grain', p: { amount: v } }; clip.effects.push(f); }
            f.p.amount = v;
          });
        }, v => v.toFixed(2)));
        continue;
      }
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
    body.append(el('div', { class: 'hint' }, `Transition at ${fmtTime(boundary)}`));
    const grid = el('div', { class: 'chip-wrap' });
    for (const [type, def] of Object.entries(TRANSITIONS)) {
      const b = el('button', { class: 'chip' + (cur.type === type ? ' on' : '') }, `${def.icon} ${def.name}`);
      b.addEventListener('click', () => {
        ed.mutate('Transition', p => {
          const tr = p.tracks.find(t => t.id === track.id);
          if (type === 'none') delete tr.transitions[clip.id];
          else tr.transitions[clip.id] = { type, dur: cur.dur || 0.3 };
        });
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
    return body;
  }

  /* ================= CANVAS ================= */
  canvasPanel() {
    const ed = this.editor;
    const p = ed.project;
    const body = el('div', { class: 'panel-body stack' });
    const presets = [
      { id: '16:9', label: '16:9 YouTube', w: 1920, h: 1080 },
      { id: '9:16', label: '9:16 Shorts/TikTok', w: 1080, h: 1920 },
      { id: '1:1', label: '1:1 Square', w: 1080, h: 1080 },
      { id: '4:5', label: '4:5 Portrait', w: 1080, h: 1350 },
      { id: '4:3', label: '4:3 Classic', w: 1440, h: 1080 },
      { id: '21:9', label: '21:9 Ultrawide', w: 2520, h: 1080 },
    ];
    const curId = (() => {
      const ar = p.width / p.height;
      let best = '16:9', bd = 1e9;
      for (const pr of presets) {
        const d = Math.abs(pr.w / pr.h - ar);
        if (d < bd) { bd = d; best = pr.id; }
      }
      return bd < 0.02 ? best : '16:9';
    })();
    body.append(
      el('div', { class: 'field-label' }, 'Aspect ratio'),
      segButtons(presets.map(x => ({ id: x.id, label: x.label })), curId, id => {
        const pr = presets.find(x => x.id === id);
        ed.mutate('Canvas', q => { q.width = pr.w; q.height = pr.h; });
        ed.onCanvasChanged();
        ed.timeline.layout();
        toast(`Canvas: ${pr.label}`);
      }),
      el('div', { class: 'color-row' }, el('label', {}, 'Background color'),
        (() => {
          const c = el('input', { type: 'color', value: p.bg || '#000000' });
          c.addEventListener('input', () => ed.mutateLive(() => { p.bg = c.value; }));
          return c;
        })()),
      el('div', { class: 'hint' }, 'Clips always fill the canvas; use Crop/Zoom on a clip to reframe. Change canvas anytime — effects and overlays adapt.'),
    );
    return body;
  }
}
