# TRALIX EDITOR

**A free, pro-grade mobile video editor built for CODM / gaming clips — running 100% in your browser.**
No account. No subscription. No watermark. Your videos never leave your device.

TRALIX EDITOR is an installable PWA (add it to your home screen on iPhone or Android) with a real
editing pipeline: everything you see in the preview is what gets exported — effects, transitions,
text, overlays, speed ramps and the full audio mix.

---

## The workflow

Import a CODM clip → trim & split on the beat-synced timeline → add music → sync cuts to beats →
drop effects (shake / zoom / glitch / RGB / flash) → transitions → color grade → preview → export
(720p–4K, 24–120fps, Standard/High/Maximum bitrate) → save to your phone gallery.

## Feature map

| Area | What's inside |
|---|---|
| **Timeline** | Multi-track (video layers, audio tracks, text, overlays), drag / trim / split / duplicate / delete, cross-track moves, pinch & slider zoom, magnetic snapping, per-track mute/hide, beat markers |
| **Speed** | 0.1×–8× presets + custom, speed ramps (N→F→S→F→N etc. — splits the clip into re-timed segments), freeze frames from the current frame |
| **Audio** | Music import, extract audio from video, voice-over recording, per-clip volume / fades / mute, waveform rendering on clips, WebAudio mixdown in exports |
| **Beat sync** | Manual tap-tempo markers, offline auto beat detection (energy flux), BPM estimate, snap-cuts-to-beats, split-at-beats, one-tap auto kill-montage builder |
| **Text** | 8 fonts, size/weight/italic/spacing/alignment, color, outline, shadow, neon glow, background box, animations (fade, slide, pop, zoom, shake, typewriter, glitch) |
| **Overlays** | Neon frame, lower third, REC indicator, kill feed, XP popups, kill counter (driven by beat markers), VS split |
| **Effects** | Blur, motion blur, glow, sharpen, vignette, grain, glitch, RGB split, chromatic aberration, screen shake, flash, zoom punch, distortion, VHS, film, cinematic (deterministic — preview matches export) |
| **Adjust** | Brightness, contrast, saturation, exposure, highlights, shadows, temperature, tint, sharpen, fade, vignette, blur + 10 grade presets |
| **Transitions** | Fade, dissolve, zoom, swipe, spin, glitch, flash, blur, shake, RGB, camera move — adjustable duration |
| **Export** | 720p/1080p/1440p/4K · 24/30/60/120 fps · Standard/High/Maximum bitrate · MP4 or WebM (best supported codec auto-picked) · real-time render with live progress · save to device or share sheet |
| **Projects** | Autosave to IndexedDB, reopen & continue, duplicate, media library shared across projects, storage usage in Settings |
| **History** | Full undo/redo with snapshot stack (60 steps) — no project reloads on small edits |
| **Local AI** | Scene detection (frame histograms), silence detection & removal, smart highlights (energy peaks → beat markers), beat detection — all on-device, zero API keys |
| **Templates** | Sniper, Quickscope, Shotgun Rush, Multiplayer, Battle Royale, Ranked Clean, Clutch — one tap applies grade + FX + transitions + title + kill counter |

## Privacy

Everything runs locally in the browser: media lives in IndexedDB on the device, exports are rendered
on-device with `MediaRecorder`, and there are no servers, accounts, analytics or uploads. Import only
media you have the rights to use.

## Run it

```bash
node server.js        # → http://localhost:8080  (also serves HTTPS-friendly headers for PWA)
```

…or any static file server (the app is plain HTML/JS/CSS — no build step). For the full experience
use Chrome/Edge (desktop or Android) or Safari 16+ (iOS). Install it as a PWA for fullscreen,
offline-capable editing.

## Tech notes

- **Rendering**: canvas compositor (`js/render.js`) + deterministic FX engine (`js/fx.js`); SVG
  filters where supported with graceful fallbacks for Safari.
- **Export**: `canvas.captureStream()` + WebAudio `MediaStreamDestination` → `MediaRecorder`
  (H.264/MP4 where supported, VP9/VP8 WebM otherwise). Best-effort 4K/120fps — capped by the device.
- **Persistence**: IndexedDB stores project JSON, media blobs and finished exports; localStorage
  stores preferences.
- **Fonts**: Orbitron, Rajdhani, Bebas Neue, Chakra Petch (OFL-licensed, bundled in `fonts/`).

TRALIX EDITOR is an original app — not affiliated with, or endorsed by, any other editor or game.
