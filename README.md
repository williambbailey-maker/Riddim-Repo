# Riddim 🥁

A drum track library you can groove over. Drop in `.wav` / `.mp3` drum tracks,
keep them organized, then loop one up and lay other instruments on top.

Riddim is a **PWA with no build step** — plain HTML/CSS/JS. Everything (including
the audio itself) is stored in your browser via IndexedDB, so your library works
fully offline and survives reloads.

## Features

- **Drag & drop import** — drop audio files anywhere on the page (or use
  *＋ Add tracks*). WAV, MP3, OGG, FLAC, M4A and friends all work.
- **Library organization** — search, sort (newest / name / BPM / duration),
  tag tracks, and filter by tag chips.
- **Built for grooving** — loop is **on by default**, so a track keeps cycling
  while you play over it. Waveform seek bar, prev/next, playback speed
  (practice slow, then bring it up), and volume.
- **BPM tagging** — type a BPM or use **tap tempo**: tap along with the track
  and Riddim averages your taps.
- **Offline PWA** — installable, service-worker cached app shell, tracks stored
  locally. Media Session integration gives you lock-screen / hardware controls.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `L` | Toggle loop |
| `←` / `→` | Seek −5s / +5s |

## Running it

It's a static site — serve the repo root over HTTP and open it:

```sh
npx http-server .          # or: python3 -m http.server
```

Then visit `http://localhost:8080`. Any static host works for real use
(GitHub Pages, Netlify, etc.); a service worker requires HTTPS or localhost.

## How it's put together

| File | Role |
| --- | --- |
| `index.html` | App shell: library grid, player bar, edit dialog |
| `js/app.js` | Import, decoding/waveforms, library UI, player, tap tempo |
| `js/db.js` | Thin IndexedDB wrapper (`tracks` store, blobs + metadata) |
| `sw.js` | Service worker: precache + stale-while-revalidate app shell |
| `manifest.webmanifest` | PWA manifest (installable, standalone display) |

On import, each file is decoded once with the Web Audio API to compute its
duration and a 480-bucket peak waveform, which are stored alongside the blob —
so the library renders waveforms instantly without re-decoding audio.
