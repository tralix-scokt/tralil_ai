/* TRALIX EDITOR — home dashboard: new project, import, recent projects, templates,
   my edits (exports), settings */
import { el, toast, fmtDur, fmtBytes, uid, deepClone, pickRecorderMime } from './util.js';
import { idb } from './idb.js';
import { newProject, CODM_TEMPLATES, makeVideoClip, makeTextClip, makeOverlayClip, DEFAULT_ADJ, clipDuration, clipsSorted, projectDuration } from './model.js';
import { mediaMap, importFiles, saveMediaMeta, loadLibrary } from './media.js';
import { openModal, confirmDlg, promptDlg, segButtons, toggle } from './dialogs.js';
import { clamp } from './util.js';

export const prefs = {
  get() {
    try { return JSON.parse(localStorage.getItem('tralix.prefs') || '{}'); } catch { return {}; }
  },
  set(patch) {
    const p = { ...this.get(), ...patch };
    localStorage.setItem('tralix.prefs', JSON.stringify(p));
    return p;
  },
};

export class HomeScreen {
  constructor(app) {
    this.app = app;
    this.host = document.getElementById('screen-home');
  }
  async show() {
    await loadLibrary();
    this.render();
  }
  render() {
    const h = this.host;
    h.innerHTML = '';

    const header = el('div', { class: 'home-header' },
      el('div', { class: 'logo' },
        el('span', { class: 'logo-t' }, 'TRALIX'),
        el('span', { class: 'logo-e' }, 'EDITOR')),
      el('div', { class: 'tagline' }, 'PRO-GRADE VIDEO EDITING FOR CODM CLIPS · FREE FOREVER'),
    );

    const actions = el('div', { class: 'home-actions' },
      el('button', { class: 'tile primary', onclick: () => this.newProjectDialog() },
        el('div', { class: 'tile-icon' }, '＋'), el('div', { class: 'tile-label' }, 'New Project'), el('div', { class: 'tile-sub' }, 'start from scratch')),
      el('button', { class: 'tile', onclick: () => this.importNewProject() },
        el('div', { class: 'tile-icon' }, '📥'), el('div', { class: 'tile-label' }, 'Import Video'), el('div', { class: 'tile-sub' }, 'from your gallery')),
      el('button', { class: 'tile', onclick: () => { document.getElementById('tpl-section').scrollIntoView({ behavior: 'smooth' }); } },
        el('div', { class: 'tile-icon' }, '⚡'), el('div', { class: 'tile-label' }, 'Templates'), el('div', { class: 'tile-sub' }, 'CODM presets')),
      el('button', { class: 'tile', onclick: () => this.myEdits() },
        el('div', { class: 'tile-icon' }, '🎞'), el('div', { class: 'tile-label' }, 'My Edits'), el('div', { class: 'tile-sub' }, 'exported videos')),
    );

    const recentSection = el('div', { class: 'home-section' }, el('div', { class: 'section-title' }, 'Recent Projects'));
    const recent = el('div', { class: 'project-grid' });
    recentSection.append(recent);

    const tplSection = el('div', { class: 'home-section', id: 'tpl-section' },
      el('div', { class: 'section-title' }, 'CODM Templates'),
      el('div', { class: 'tpl-grid' },
        ...CODM_TEMPLATES.map(tpl => el('button', { class: 'tpl-card', onclick: () => this.useTemplate(tpl) },
          el('div', { class: 'tpl-icon' }, tpl.icon),
          el('div', { class: 'tpl-body' },
            el('div', { class: 'tpl-name' }, tpl.name),
            el('div', { class: 'tpl-desc' }, tpl.desc))))));

    const settingsBtn = el('button', { class: 'btn wide', onclick: () => this.settingsDialog() }, '⚙ Settings & Storage');
    h.append(header, actions, recentSection, tplSection, settingsBtn,
      el('div', { class: 'foot-note' }, 'TRALIX EDITOR v1.0 · 100% on-device editing. Your videos never leave your phone. No accounts, no subscriptions, no watermarks.'));

    // recent projects
    idb.getAll('projects').then(rows => {
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      if (!rows.length) {
        recent.append(el('div', { class: 'hint pad' }, 'No projects yet — create one or import a clip.'));
        return;
      }
      for (const row of rows.slice(0, 12)) {
        const card = el('div', { class: 'project-card' });
        if (row.thumb) card.style.backgroundImage = `linear-gradient(to top, rgba(6,9,18,.94) 20%, rgba(6,9,18,.1)), url(${row.thumb})`;
        card.append(
          el('div', { class: 'pc-name' }, row.name),
          el('div', { class: 'pc-meta' }, `${fmtDur(row.duration || 0)} · ${new Date(row.updatedAt).toLocaleDateString()}`),
          el('div', { class: 'pc-actions' },
            el('button', { class: 'btn small primary', onclick: () => this.openProjectRow(row) }, 'Open'),
            el('button', { class: 'btn small', onclick: e => { e.stopPropagation(); this.projectMenu(row); } }, '⋯'),
          ),
        );
        card.addEventListener('click', () => this.openProjectRow(row));
        recent.append(card);
      }
    });
  }

  async openProjectRow(row) {
    const state = JSON.parse(row.state);
    this.app.openEditor(state);
  }

  projectMenu(row) {
    openModal({
      title: row.name, width: 380,
      body: el('div', { class: 'stack' },
        el('div', { class: 'hint' }, `Updated ${new Date(row.updatedAt).toLocaleString()} · ${fmtDur(row.duration || 0)}`),
        el('button', { class: 'btn', onclick: () => { promptDlg('Rename project', row.name, v => { if (v) { row.name = v; row.updatedAt = Date.now(); idb.put('projects', row); this.render(); } }); } }, '✎ Rename'),
        el('button', {
          class: 'btn', onclick: () => {
            const copy = { ...row, id: uid(), name: row.name + ' copy', updatedAt: Date.now() };
            const st = JSON.parse(row.state); st.id = copy.id; st.name = copy.name;
            copy.state = JSON.stringify(st);
            idb.put('projects', copy).then(() => { this.render(); toast('Duplicated'); });
          },
        }, '⧉ Duplicate'),
        el('button', {
          class: 'btn danger', onclick: () => {
            confirmDlg('Delete this project? Media in the library is kept.', async () => { await idb.delete('projects', row.id); this.render(); }, 'Delete');
          },
        }, '🗑 Delete'),
      ),
      actions: [{ label: 'Close', kind: 'ghost' }],
    });
  }

  newProjectDialog(nameHint = '') {
    const name = el('input', { class: 'input', type: 'text', value: nameHint || 'CODM Edit ' + new Date().toLocaleDateString(), placeholder: 'Project name' });
    let resId = '1920x1080', fps = 60;
    const resOpts = [
      { id: '1920x1080', label: '1080p 16:9' }, { id: '1280x720', label: '720p' },
      { id: '2560x1440', label: '1440p' }, { id: '3840x2160', label: '4K' },
      { id: '1080x1920', label: '9:16 vertical' }, { id: '1080x1080', label: '1:1 square' },
    ];
    const fpsOpts = [{ id: '24', label: '24' }, { id: '25', label: '25' }, { id: '30', label: '30' }, { id: '60', label: '60' }];
    let resHost, fpsHost;
    const body = el('div', { class: 'stack' },
      el('div', { class: 'field-label' }, 'Name'), name,
      el('div', { class: 'field-label' }, 'Canvas'), resHost = segButtons(resOpts, resId, id => resId = id),
      el('div', { class: 'field-label' }, 'Frame rate'), fpsHost = segButtons(fpsOpts, String(fps), id => fps = Number(id)),
      el('div', { class: 'hint' }, 'You can change all of this later in Project Settings.'),
    );
    openModal({
      title: 'New Project', width: 460, body,
      actions: [
        {
          label: 'Create', kind: 'primary', onclick: () => {
            const [w, h] = resId.split('x').map(Number);
            const p = newProject({ name: name.value.trim() || 'Untitled', width: w, height: h, fps });
            this.app.openEditor(p);
          },
        },
        { label: 'Cancel', kind: 'ghost' },
      ],
    });
  }

  async importNewProject() {
    const input = el('input', { type: 'file', accept: 'video/*,audio/*', multiple: true, style: { display: 'none' } });
    document.body.append(input);
    input.addEventListener('change', async () => {
      input.remove();
      if (!input.files.length) return;
      const p = newProject({ name: 'CODM Edit ' + new Date().toLocaleDateString() });
      this.app.openEditor(p);
      await this.app.importIntoProject(this.app.editor, input.files, () => {
        const m = openModal({ title: 'Importing…', body: el('div', { class: 'hint' }, 'Reading clips…'), actions: [] });
        return { done: () => m.close(), set: s => { const f = m.bodyEl.firstChild; if (f) f.textContent = s; } };
      });
    }, { once: true });
    input.click();
  }

  useTemplate(tpl) {
    confirmDlg(
      `“${tpl.name}”: ${tpl.desc}. Create a new project, then pick your clips — the template grade, effects, transitions, title and kill-counter are applied automatically.`,
      () => this.newProjectDialog(tpl.name + ' — ' + new Date().toLocaleDateString()),
      'Create', false);
    this.app.pendingTemplate = tpl;
    // if user creates via dialog above, pendingTemplate is applied after first import
  }

  async myEdits() {
    const rows = (await idb.getAll('exports')).sort((a, b) => b.createdAt - a.createdAt);
    const body = el('div', { class: 'stack' });
    if (!rows.length) {
      body.append(el('div', { class: 'hint' }, 'No exported videos yet. Export a project and it will appear here (also saved to your device gallery/downloads).'));
    }
    for (const row of rows) {
      const rowEl = el('div', { class: 'edit-row' },
        el('div', { class: 'grow' },
          el('div', { class: 'pc-name' }, row.name),
          el('div', { class: 'pc-meta' }, `${row.width}×${row.height} · ${row.fps}fps · ${fmtBytes(row.size)} · ${new Date(row.createdAt).toLocaleString()}`)),
        el('button', { class: 'btn small primary', onclick: () => this.playExport(row) }, '▶'),
        el('button', { class: 'btn small', onclick: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(row.blob); a.download = row.name; a.click(); toast('Saving…'); } }, '⬇'),
        el('button', { class: 'btn small danger', onclick: () => confirmDlg('Remove from My Edits?', async () => { await idb.delete('exports', row.id); this.myEdits(); }, 'Remove') }, '🗑'),
      );
      body.append(rowEl);
    }
    openModal({ title: 'My Edits', width: 560, body, actions: [{ label: 'Close', kind: 'ghost' }] });
  }

  playExport(row) {
    const v = el('video', { controls: '', playsInline: '', style: { width: '100%', maxHeight: '50vh', background: '#000' } });
    const url = URL.createObjectURL(row.blob);
    v.src = url;
    openModal({ title: row.name, body: v, pad: false, actions: [{ label: 'Close', kind: 'ghost', onclick: () => { v.pause(); URL.revokeObjectURL(url); } }] });
    v.play().catch(() => { });
  }

  settingsDialog() {
    const p = prefs.get();
    const body = el('div', { class: 'stack' });
    body.append(
      el('div', { class: 'field-label' }, 'Default export'),
      el('div', { class: 'hint' }, `Format: ${pickRecorderMime()?.includes('mp4') ? 'MP4' : 'WebM'} (auto-detected) · defaults can be changed on the export screen each time.`),
      el('div', { class: 'field-label' }, 'Preview quality'),
      segButtons([
        { id: 'full', label: 'Full (slower)' }, { id: 'half', label: 'Balanced' }, { id: 'quarter', label: 'Smooth (fast)' },
      ], p.previewQuality || 'half', id => prefs.set({ previewQuality: id })),
      toggle('Snap clips to beats & edges', p.snap !== false, v => prefs.set({ snap: v })),
      el('div', { class: 'field-label' }, 'Storage'),
    );
    const usage = el('div', { class: 'hint' }, 'Calculating…');
    body.append(usage,
      el('button', { class: 'btn', onclick: () => confirmDlg('Delete ALL projects, media and exports on this device?', async () => { await Promise.all([idb.clear('projects'), idb.clear('media'), idb.clear('exports'), idb.clear('kv')]); mediaMap.clear(); location.reload(); }, 'Delete everything') }, '🧹 Clear all data'),
      el('div', { class: 'field-label' }, 'About & privacy'),
      el('div', { class: 'hint' }, 'TRALIX EDITOR is a free pro video editor tuned for CODM clips. All editing, effects, AI analysis and exporting run 100% on your device — no uploads, no servers, no accounts, no watermarks. Import only media you have the rights to use.'),
    );
    navigator.storage?.estimate?.().then(est => {
      usage.textContent = `Using ${fmtBytes(est.usage || 0)} of ~${fmtBytes(est.quota || 0)} available`;
    }).catch(() => { usage.textContent = 'Storage info unavailable'; });
    openModal({ title: 'Settings', width: 480, body, actions: [{ label: 'Done', kind: 'primary' }] });
  }
}

/* apply a CODM template to a project (after its clips are imported) */
export function applyTemplate(project, tpl) {
  const vt = project.tracks.find(t => t.kind === 'video');
  const clips = clipsSorted(vt);
  if (!clips.length) return;
  for (const c of clips) {
    c.adj = { ...DEFAULT_ADJ(), ...(tpl.grade || {}) };
    if (c.adj.grainV) { c.adj.fade = (c.adj.fade || 0) + 0.06; delete c.adj.grainV; }
    c.effects = c.effects || [];
    for (const type of tpl.fx || []) {
      if (!c.effects.some(f => f.type === type)) {
        const pDefault = {};
        c.effects.push({ id: uid(), type, p: pDefault });
      }
    }
    if (tpl.slowmo && Math.random() < 0.34) c.speed = tpl.slowmo;
  }
  // transitions between consecutive clips
  for (let i = 0; i < clips.length - 1; i++) {
    if (tpl.transition) vt.transitions[clips[i].id] = { ...tpl.transition };
  }
  // title text
  if (tpl.title) {
    const tc = makeTextClip(0, Math.min(2.6, projectDuration(project)), tpl.title);
    tc.font = 'Orbitron'; tc.size = 11; tc.glow = { on: true, color: '#00e5ff', strength: 1.3 };
    tc.letterSpacing = 5; tc.anim.in = 'zoom'; tc.anim.out = 'fade';
    project.tracks.find(t => t.kind === 'text').clips.push(tc);
  }
  // kill counter overlay
  if (tpl.counter) {
    const oc = makeOverlayClip('counter', 0, Math.max(2, projectDuration(project)), { prefix: 'KILLS', start: 0, per: 1, color: '#00e5ff' });
    project.tracks.find(t => t.kind === 'overlay').clips.push(oc);
  }
  if (tpl.killfeed) {
    const oc = makeOverlayClip('killfeed', 0.5, Math.max(3, projectDuration(project) - 1), { color: '#ff3355', interval: 1.7 });
    project.tracks.find(t => t.kind === 'overlay').clips.push(oc);
  }
}
