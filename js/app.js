/* TRALIX EDITOR — app shell: routing, project lifecycle, import pipeline */
import { el, toast, deepClone, uid } from './util.js';
import { idb } from './idb.js';
import { newProject, projectDuration, clipsSorted, clipDuration, makeVideoClip } from './model.js';
import { mediaMap, importFiles, saveMediaMeta } from './media.js';
import { EditorScreen } from './editor.js';
import { HomeScreen, applyTemplate, prefs } from './home.js';

const app = {
  editor: null,
  home: null,
  pendingTemplate: null,

  async init() {
    this.home = new HomeScreen(this);
    await this.home.show();
    this.registerSW();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.editor) this.editor.save();
    });
    window.addEventListener('beforeunload', () => { if (this.editor) this.editor.save(true); });
    // pinch/zoom suppression for app feel
    document.addEventListener('gesturestart', e => e.preventDefault());
  },

  registerSW() {
    if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
      navigator.serviceWorker.register('sw.js').catch(() => { });
    }
  },

  showHome() {
    document.getElementById('screen-editor').classList.add('hidden');
    document.getElementById('screen-home').classList.remove('hidden');
    this.editor = null;
    this.home.show();
    window.scrollTo(0, 0);
  },

  openEditor(project) {
    document.getElementById('screen-home').classList.add('hidden');
    const scr = document.getElementById('screen-editor');
    scr.classList.remove('hidden');
    this.editor = new EditorScreen(this, project);
    const tpl = this.pendingTemplate;
    if (tpl) {
      this.pendingTemplate = null;
      setTimeout(() => this.promptTemplateImport(project, tpl), 350);
    }
  },

  promptTemplateImport(project, tpl) {
    const input = el('input', { type: 'file', accept: 'video/*', multiple: true, style: { display: 'none' } });
    document.body.append(input);
    input.addEventListener('change', async () => {
      input.remove();
      if (!input.files.length) return;
      await this.importIntoProject(this.editor, input.files);
      applyTemplate(project, tpl);
      this.editor.afterChange();
      toast(`Template “${tpl.name}” applied to ${input.files.length} clip(s)`);
    }, { once: true });
    input.click();
    toast(`Template “${tpl.name}” — now pick your clips`);
  },

  /* import files into the CURRENT project: appends to Video 1 sequentially */
  async importIntoProject(editor, files, progressCb) {
    const list = [...files];
    let prog = progressCb ? progressCb() : null;
    const recs = await importFiles(list, (i, n, name) => {
      prog && prog.set(`Importing ${i + 1}/${n} — ${name}`);
    });
    prog && prog.done();
    if (!recs.length) { toast('No supported video/audio files found'); return []; }
    let t = 0;
    const vt = editor.project.tracks.find(x => x.kind === 'video');
    for (const c of clipsSorted(vt)) t = Math.max(t, c.start + clipDuration(c));
    for (const rec of recs) {
      saveMediaMeta(rec);
      if (rec.kind === 'video') {
        editor.project.tracks.filter(x => x.kind === 'video')[0].clips.push(makeVideoClip(rec, t));
        t += Math.max(0.2, rec.duration || 3);
      } else {
        const at = editor.project.tracks.filter(x => x.kind === 'audio').pop();
        const { makeAudioClip } = await import('./model.js');
        at.clips.push(makeAudioClip(rec, t));
        t += Math.max(0.2, rec.duration || 3);
      }
    }
    editor.afterChange();
    editor.player.prepare().then(() => editor.player.requestDraw());
    editor.timeline.fit();
    toast(`Imported ${recs.length} file(s)`);
    return recs;
  },
};

window.addEventListener('DOMContentLoaded', () => app.init());
export { app };
