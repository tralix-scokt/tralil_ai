/* TRALIX EDITOR — audio engine: WebAudio scheduling of every clip (video + audio tracks),
   fades, speed, master graph, voice-over recording, export tap */
import { mediaMap, peekAudioBuffer, getAudioBuffer, audioCtx } from './media.js';
import { clipDuration, clipsSorted } from './model.js';
import { clamp } from './util.js';

class AudioEngine {
  constructor() {
    this.voices = [];
    this.graphReady = false;
    this.speakerMuted = false;
    this._token = 0;
  }
  ensureGraph() {
    if (this.graphReady) return;
    const ctx = audioCtx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -10; this.comp.ratio.value = 6; this.comp.knee.value = 12;
    this.speakerGain = ctx.createGain();
    this.exportDest = ctx.createMediaStreamDestination();
    this.master.connect(this.comp);
    this.comp.connect(this.speakerGain);
    this.speakerGain.connect(ctx.destination);
    this.comp.connect(this.exportDest);
    this.speakerGain.gain.value = this.speakerMuted ? 0 : 1;
    this.graphReady = true;
  }
  setSpeakerMuted(m) {
    this.speakerMuted = m;
    if (this.graphReady) this.speakerGain.gain.value = m ? 0 : 1;
  }

  /* schedule all audio for playback starting at timeline time fromT.
     anchor: ctx.currentTime value that corresponds to fromT */
  schedule(project, fromT, anchor) {
    this.ensureGraph();
    this.stopAll();
    const ctx = this.ctx;
    const anchor2 = anchor !== undefined ? anchor : ctx.currentTime + 0.06;
    const token = ++this._token;
    this.currentFrom = fromT;
    this.currentAnchor = anchor2;
    this.playing = true;

    const jobs = [];
    for (const track of project.tracks) {
      if (track.muted || track.kind === 'text' || track.kind === 'overlay') continue;
      for (const clip of track.clips) {
        if (clip.muted) continue;
        if (track.kind === 'video' && clip.kind !== 'video') continue;
        if (track.kind === 'audio' && clip.kind !== 'audio' && clip.kind !== 'video') continue;
        const media = mediaMap.get(clip.mediaId);
        if (!media) continue;
        const buf = peekAudioBuffer(media.id);
        if (buf) jobs.push({ clip, buf });
        else jobs.push({ clip, buf: null, media });
      }
    }
    for (const job of jobs) {
      if (job.buf) this.startVoice(job.clip, job.buf, fromT, anchor2);
      else {
        // decode lazily, then join playback if it's still the same playback session
        getAudioBuffer(job.media).then(buf => {
          if (!buf) return;
          if (this._token === token && this.playing) this.startVoice(job.clip, buf, this.currentFrom, this.currentAnchor);
        }).catch(() => { });
      }
    }
  }

  startVoice(clip, buf, fromT, anchor) {
    const ctx = this.ctx;
    const dur = clipDuration(clip);
    const clipStart = clip.start, clipEnd = clip.start + dur;
    if (clipEnd <= fromT + 0.005) return;
    const speed = clamp(clip.speed || 1, 0.1, 8);
    const startsInFuture = clipStart > fromT;
    const when = Math.max(ctx.currentTime + 0.02, anchor + (clipStart - fromT));
    const intoClip = Math.max(0, fromT - clipStart);           // timeline seconds already played
    const offset = clip.in + intoClip * speed;                 // source seconds
    const playDur = (clipEnd - Math.max(fromT, clipStart)) * speed;
    if (offset >= buf.duration - 0.01) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speed;
    const gain = ctx.createGain();
    src.connect(gain); gain.connect(this.master);

    const vol = clamp(clip.volume ?? 1, 0, 2);
    const t0 = when, t1 = when + playDur;
    if (!startsInFuture && clip.fadeIn > 0.01) {
      const already = intoClip * speed;
      const remain = clip.fadeIn * speed - already;
      if (remain > 0) {
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(vol, t0 + remain);
      } else gain.gain.setValueAtTime(vol, t0);
    } else {
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + Math.min(0.012, playDur / 4));
      if (startsInFuture && clip.fadeIn > 0.01) gain.gain.linearRampToValueAtTime(vol, t0 + clip.fadeIn * speed);
    }
    if (clip.fadeOut > 0.01) {
      gain.gain.setValueAtTime(vol, Math.max(t0, t1 - clip.fadeOut * speed));
      gain.gain.linearRampToValueAtTime(0, t1);
    }
    try {
      src.start(t0, offset, Math.min(playDur + 0.05, buf.duration - offset));
      if (isFinite(t1)) src.stop(t1 + 0.02);
    } catch { /* offset race */ }
    this.voices.push({ src, gain });
  }

  stopAll() {
    this._token++;
    for (const v of this.voices) {
      try { v.src.onended = null; v.src.stop(0); } catch { }
      try { v.gain.disconnect(); } catch { }
    }
    this.voices = [];
    this.playing = false;
  }

  /* per-clip one-shot audition (e.g. preview a trim) */
  previewClip(clip, seconds = 4) {
    this.ensureGraph();
    const media = mediaMap.get(clip.mediaId);
    if (!media) return;
    getAudioBuffer(media).then(buf => {
      if (!buf) return;
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = clamp(clip.volume ?? 1, 0, 2);
      src.connect(g); g.connect(this.master);
      src.start(ctx.currentTime + 0.02, clip.in, Math.min(seconds * (clip.speed || 1), buf.duration - clip.in));
      this.voices.push({ src, gain: g });
    });
  }

  /* ---- voice-over ---- */
  async startRecording() {
    this.ensureGraph();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.recStream = stream;
    this.recChunks = [];
    this.recorder = new MediaRecorder(stream);
    this.recorder.ondataavailable = e => { if (e.data.size) this.recChunks.push(e.data); };
    this.recorder.start(200);
    this.recStartCtx = this.ctx.currentTime;
    return true;
  }
  stopRecording() {
    return new Promise(resolve => {
      if (!this.recorder) return resolve(null);
      this.recorder.onstop = async () => {
        this.recStream.getTracks().forEach(t => t.stop());
        const blob = new Blob(this.recChunks, { type: this.recorder.mimeType || 'audio/webm' });
        this.recorder = null; this.recStream = null;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }

  exportAudioTracks() {
    this.ensureGraph();
    return this.exportDest.stream.getAudioTracks();
  }
}

export const audioEngine = new AudioEngine();

/* ---------------- analysis: silence / beats ---------------- */
export function analyzeSilence(audioBuffer, { threshDb = -38, minDur = 0.35 } = {}) {
  const ch = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const win = Math.floor(sr * 0.05);
  const windows = Math.floor(ch.length / win);
  const lin = Math.pow(10, threshDb / 20);
  const silent = new Array(windows);
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    const s = w * win;
    for (let i = s; i < s + win; i += 4) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / (win / 4));
    silent[w] = rms < lin;
  }
  // merge into ranges
  const ranges = [];
  let s = -1;
  for (let w = 0; w <= windows; w++) {
    const isSil = w < windows ? silent[w] : false;
    if (isSil && s === -1) s = w;
    if (!isSil && s !== -1) {
      const dur = (w - s) * 0.05;
      if (dur >= minDur) ranges.push([s * 0.05, w * 0.05]);
      s = -1;
    }
  }
  return ranges;
}

export function detectBeats(audioBuffer, { sensitivity = 1.25, minBpm = 60, maxBpm = 220 } = {}) {
  const ch = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const hop = 512;
  const nFrames = Math.floor(ch.length / hop);
  const energy = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const s = f * hop;
    for (let i = s; i < s + hop; i += 2) sum += ch[i] * ch[i];
    energy[f] = Math.sqrt(sum / (hop / 2));
  }
  // spectral-flux-ish positive difference on smoothed energy
  const flux = new Float32Array(nFrames);
  let prev = 0;
  for (let f = 0; f < nFrames; f++) {
    const sm = f > 0 ? energy[f] * 0.7 + energy[f - 1] * 0.3 : energy[f];
    flux[f] = Math.max(0, sm - prev);
    prev = sm;
  }
  // adaptive threshold via moving median (approx with moving average * sensitivity)
  const win = Math.max(8, Math.floor(sr / hop * 0.7)); // ~0.7s window
  let ma = 0;
  const beats = [];
  const minGap = Math.floor((60 / maxBpm) * sr / hop);
  let lastBeat = -minGap * 2;
  for (let f = 0; f < nFrames; f++) {
    ma += flux[f]; if (f >= win) ma -= flux[f - win];
    const avg = ma / Math.min(f + 1, win);
    const t = (f * hop) / sr;
    if (flux[f] > avg * sensitivity && flux[f] > 0.008 && f - lastBeat >= minGap) {
      beats.push(t);
      lastBeat = f;
    }
  }
  // bpm estimate from median gap
  let bpm = 0;
  if (beats.length > 4) {
    const gaps = [];
    for (let i = 1; i < beats.length; i++) gaps.push(beats[i] - beats[i - 1]);
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    if (med > 0) {
      let b = 60 / med;
      while (b < minBpm) b *= 2;
      while (b > maxBpm) b /= 2;
      bpm = Math.round(b);
    }
  }
  return { beats, bpm };
}
