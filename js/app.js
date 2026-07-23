/* Riddim Repo — drop in drum tracks, keep them organized, loop a groove. */

(() => {
  'use strict';

  // ---------- State ----------

  let tracks = [];            // metadata records (no blobs)
  let currentId = null;       // id of the track loaded in the player
  let editingId = null;       // track being edited in the dialog
  let currentUrl = null;      // object URL of the loaded blob

  const audio = new Audio();
  audio.loop = true;          // grooves loop by default

  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // ---------- Elements ----------

  const $ = id => document.getElementById(id);
  const els = {
    library: $('library'),
    emptyState: $('empty-state'),
    search: $('search'),
    sort: $('sort'),
    sectionHead: $('section-head'),
    trackCount: $('track-count'),
    addBtn: $('add-btn'),
    fileInput: $('file-input'),
    dropOverlay: $('drop-overlay'),
    player: $('player'),
    playerWave: $('player-wave'),
    playerTitle: $('player-title'),
    playerMeta: $('player-meta'),
    timeCurrent: $('time-current'),
    timeTotal: $('time-total'),
    playBtn: $('play-btn'),
    prevBtn: $('prev-btn'),
    nextBtn: $('next-btn'),
    loopBtn: $('loop-btn'),
    rate: $('rate'),
    volume: $('volume'),
    editDialog: $('edit-dialog'),
    editForm: $('edit-form'),
    editName: $('edit-name'),
    editBpm: $('edit-bpm'),
    editDelete: $('edit-delete'),
    editCancel: $('edit-cancel'),
    tapTempo: $('tap-tempo'),
    toast: $('toast'),
  };

  // ---------- Utilities ----------

  function formatTime(seconds) {
    if (!isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }

  function cleanName(filename) {
    return filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  }

  let toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
  }

  // ---------- Waveform peaks ----------

  const PEAK_COUNT = 480;

  function computePeaks(audioBuffer) {
    const channel = audioBuffer.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(channel.length / PEAK_COUNT));
    const peaks = new Array(PEAK_COUNT).fill(0);
    for (let i = 0; i < PEAK_COUNT; i++) {
      const start = i * bucketSize;
      const end = Math.min(start + bucketSize, channel.length);
      let max = 0;
      const stride = Math.max(1, Math.floor((end - start) / 64));
      for (let j = start; j < end; j += stride) {
        const v = Math.abs(channel[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    const overall = Math.max(...peaks, 0.001);
    return peaks.map(p => Math.round((p / overall) * 100) / 100);
  }

  function drawWave(canvas, peaks, progress, colors) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const n = peaks.length;
    const barW = width / n;
    const mid = height / 2;
    const playedBars = Math.floor(progress * n);

    for (let i = 0; i < n; i++) {
      const h = Math.max(1.5, peaks[i] * (height - 4));
      ctx.fillStyle = i < playedBars ? colors.played : colors.base;
      ctx.fillRect(i * barW, mid - h / 2, Math.max(1, barW * 0.7), h);
    }
  }

  const css = getComputedStyle(document.documentElement);
  const WAVE_COLORS = {
    base: css.getPropertyValue('--wave').trim() || '#3A3230',
    played: css.getPropertyValue('--orange').trim() || '#EC5620',
  };
  // Card waveforms sit on bright color blocks — dark ink bars.
  const CARD_WAVE_COLORS = { base: 'rgba(6, 0, 0, 0.35)', played: 'rgba(6, 0, 0, 0.35)' };

  // Stable color assignment per track (yellow/orange/green/pink cycle).
  function cardColorClass(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return 'card-c' + (h % 4);
  }

  // ---------- Import ----------

  const AUDIO_EXT = /\.(wav|mp3|ogg|oga|flac|m4a|aac|aiff?|webm)$/i;

  function isAudioFile(file) {
    return file.type.startsWith('audio/') || AUDIO_EXT.test(file.name);
  }

  /** Decode, compute peaks, store in IndexedDB. Returns the track meta. */
  async function importOneFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    let duration = 0;
    let peaks = null;
    try {
      const decoded = await getAudioCtx().decodeAudioData(arrayBuffer.slice(0));
      duration = decoded.duration;
      peaks = computePeaks(decoded);
    } catch (err) {
      console.warn('Could not decode (storing anyway):', file.name, err);
    }

    const track = {
      id: crypto.randomUUID(),
      name: cleanName(file.name),
      fileName: file.name,
      type: file.type || 'audio/mpeg',
      size: file.size,
      duration,
      peaks,
      bpm: null,
      percussion: false,
      addedAt: Date.now(),
      blob: new Blob([arrayBuffer], { type: file.type || 'audio/mpeg' }),
    };

    await RiddimDB.put(track);
    const { blob, ...meta } = track;
    tracks.push(meta);
    return meta;
  }

  /** Ship-with-the-app starter groove, imported once on first run. */
  const SEED_FLAG = 'riddim-repo-seeded-v1';
  async function seedSampleTrack() {
    if (localStorage.getItem(SEED_FLAG)) return;
    try {
      const res = await fetch('samples/zuchinni-dryne.wav');
      if (!res.ok) return;
      const blob = await res.blob();
      const file = new File([blob], 'Zuchinni Dryne.wav', { type: 'audio/wav' });
      const meta = await importOneFile(file);
      const patched = await RiddimDB.patch(meta.id, { bpm: 65 });
      const idx = tracks.findIndex(t => t.id === meta.id);
      if (idx !== -1) tracks[idx] = patched;
      localStorage.setItem(SEED_FLAG, '1');
      render();
    } catch (err) {
      console.warn('Sample seed skipped:', err);
    }
  }

  /** One-time fix: the bundled groove was first tagged 130 BPM; it's 65. */
  const BPM_FIX_FLAG = 'riddim-zd-bpm65';
  async function fixSeededBpm() {
    if (localStorage.getItem(BPM_FIX_FLAG)) return;
    try {
      const zd = tracks.find(t => t.fileName === 'Zuchinni Dryne.wav' && t.bpm === 130);
      if (zd) {
        const patched = await RiddimDB.patch(zd.id, { bpm: 65 });
        const idx = tracks.findIndex(t => t.id === zd.id);
        if (idx !== -1) tracks[idx] = patched;
        render();
      }
      localStorage.setItem(BPM_FIX_FLAG, '1');
    } catch (err) {
      console.warn('BPM fix skipped:', err);
    }
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList).filter(isAudioFile);
    const skipped = fileList.length - files.length;
    if (!files.length) {
      toast('No audio files found — drop .wav or .mp3 tracks');
      return;
    }

    toast(`Importing ${files.length} track${files.length > 1 ? 's' : ''}…`);
    let imported = 0;

    for (const file of files) {
      try {
        await importOneFile(file);
        imported++;
      } catch (err) {
        console.error('Import failed:', file.name, err);
        toast(`Couldn't import ${file.name}`);
      }
    }

    render();
    if (imported) {
      toast(`Added ${imported} track${imported > 1 ? 's' : ''}` +
            (skipped > 0 ? ` (skipped ${skipped} non-audio)` : ''));
    }
  }

  // ---------- Library rendering ----------

  function visibleTracks() {
    const query = els.search.value.trim().toLowerCase();
    let list = tracks.filter(t => {
      if (!query) return true;
      const haystack = (t.name + ' ' + (t.bpm || '')).toLowerCase();
      return query.split(/\s+/).every(word => haystack.includes(word));
    });

    const [key, dir] = els.sort.value.split('-');
    const sign = dir === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      let va, vb;
      switch (key) {
        case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
        case 'bpm': va = a.bpm || Infinity; vb = b.bpm || Infinity; break;
        case 'duration': va = a.duration || 0; vb = b.duration || 0; break;
        default: va = a.addedAt; vb = b.addedAt;
      }
      return va < vb ? -sign : va > vb ? sign : 0;
    });
    return list;
  }

  function renderLibrary() {
    const list = visibleTracks();
    els.library.innerHTML = '';
    els.emptyState.style.display = tracks.length ? 'none' : '';
    els.sectionHead.hidden = tracks.length === 0;
    els.trackCount.textContent = tracks.length === 1 ? '1 track' : `${tracks.length} tracks`;

    for (const t of list) {
      const card = document.createElement('article');
      card.className = 'track-card ' + cardColorClass(t.id) + (t.id === currentId ? ' playing' : '');
      card.dataset.id = t.id;

      const head = document.createElement('div');
      head.className = 'track-head';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'track-play';
      playBtn.textContent = (t.id === currentId && !audio.paused) ? '❚❚' : '▶';
      playBtn.setAttribute('aria-label', 'Play ' + t.name);

      const titles = document.createElement('div');
      titles.className = 'track-titles';
      const name = document.createElement('div');
      name.className = 'track-name';
      name.textContent = t.name;
      const sub = document.createElement('div');
      sub.className = 'track-pills';
      if (t.bpm) {
        const bpm = document.createElement('span');
        bpm.className = 'track-pill track-bpm';
        bpm.textContent = Math.round(t.bpm * 10) / 10 + ' BPM';
        sub.appendChild(bpm);
      }
      const date = document.createElement('span');
      date.className = 'track-pill track-date';
      date.textContent = 'Added ' + formatDate(t.addedAt);
      sub.appendChild(date);
      titles.append(name, sub);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'track-edit';
      editBtn.textContent = 'Edit';
      editBtn.title = 'Edit name and BPM';
      editBtn.setAttribute('aria-label', 'Edit ' + t.name);

      head.append(playBtn, titles, editBtn);
      card.appendChild(head);

      if (t.peaks) {
        const canvas = document.createElement('canvas');
        canvas.className = 'track-wave';
        card.appendChild(canvas);
        requestAnimationFrame(() => drawWave(canvas, t.peaks, 0, CARD_WAVE_COLORS));
      }

      const percLabel = document.createElement('label');
      percLabel.className = 'perc-check';
      const percBox = document.createElement('input');
      percBox.type = 'checkbox';
      percBox.checked = !!t.percussion;
      const percText = document.createElement('span');
      percText.textContent = 'Percussion';
      percLabel.append(percBox, percText);
      percLabel.addEventListener('click', e => e.stopPropagation());
      percBox.addEventListener('change', async () => {
        try {
          const patched = await RiddimDB.patch(t.id, { percussion: percBox.checked });
          const idx = tracks.findIndex(x => x.id === t.id);
          if (idx !== -1) tracks[idx] = patched;
        } catch (err) {
          console.error(err);
          percBox.checked = !percBox.checked;
          toast('Could not save');
        }
      });
      card.appendChild(percLabel);

      card.addEventListener('click', event => {
        if (event.target === editBtn) return;
        if (t.id === currentId) {
          togglePlay();
        } else {
          playTrack(t.id);
        }
      });
      editBtn.addEventListener('click', () => openEdit(t.id));

      els.library.appendChild(card);
    }
  }

  function render() {
    renderLibrary();
  }

  // ---------- Player ----------

  function currentTrack() {
    return tracks.find(t => t.id === currentId) || null;
  }

  async function playTrack(id) {
    const record = await RiddimDB.get(id);
    if (!record) {
      toast('Track not found');
      return;
    }
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(record.blob);
    currentId = id;

    audio.src = currentUrl;
    audio.playbackRate = parseFloat(els.rate.value);
    try {
      await audio.play();
    } catch (err) {
      console.warn('Playback failed:', err);
    }

    els.player.hidden = false;
    updatePlayerHeader();
    updateMediaSession();
    render();
  }

  function togglePlay() {
    if (!currentId) {
      const list = visibleTracks();
      if (list.length) playTrack(list[0].id);
      return;
    }
    if (audio.paused) audio.play();
    else audio.pause();
  }

  function step(direction) {
    const list = visibleTracks();
    if (!list.length) return;
    const idx = list.findIndex(t => t.id === currentId);
    const next = idx === -1
      ? (direction > 0 ? list[0] : list[list.length - 1])
      : list[(idx + direction + list.length) % list.length];
    playTrack(next.id);
  }

  function updatePlayerHeader() {
    const t = currentTrack();
    if (!t) return;
    els.playerTitle.textContent = t.name;
    els.playerMeta.innerHTML = '';
    if (t.bpm) {
      const bpm = document.createElement('span');
      bpm.className = 'track-bpm';
      bpm.textContent = Math.round(t.bpm * 10) / 10 + ' BPM';
      els.playerMeta.appendChild(bpm);
    }
    els.playerMeta.appendChild(
      document.createTextNode('Added ' + formatDate(t.addedAt))
    );
    els.timeTotal.textContent = formatTime(t.duration || audio.duration);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = currentTrack();
    if (!t) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.name,
      artist: t.bpm ? `${Math.round(t.bpm)} BPM` : 'Riddim Repo',
      album: 'Riddim Repo',
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
  }

  function playerFrame() {
    const t = currentTrack();
    if (t && t.peaks && !els.player.hidden) {
      const progress = audio.duration ? audio.currentTime / audio.duration : 0;
      drawWave(els.playerWave, t.peaks, progress, WAVE_COLORS);
      els.timeCurrent.textContent = formatTime(audio.currentTime);
    }
    requestAnimationFrame(playerFrame);
  }

  function syncPlayButtons() {
    els.playBtn.textContent = audio.paused ? '▶' : '❚❚';
    for (const card of els.library.querySelectorAll('.track-card')) {
      const btn = card.querySelector('.track-play');
      if (btn) {
        btn.textContent = (card.dataset.id === currentId && !audio.paused) ? '❚❚' : '▶';
      }
    }
  }

  audio.addEventListener('play', syncPlayButtons);
  audio.addEventListener('pause', syncPlayButtons);
  audio.addEventListener('ended', () => {
    // Only fires when loop is off — move on to the next groove.
    step(1);
  });

  els.playBtn.addEventListener('click', togglePlay);
  els.prevBtn.addEventListener('click', () => step(-1));
  els.nextBtn.addEventListener('click', () => step(1));

  els.loopBtn.addEventListener('click', () => {
    audio.loop = !audio.loop;
    els.loopBtn.classList.toggle('toggled', audio.loop);
    toast(audio.loop ? 'Loop on — groove locked in' : 'Loop off');
  });

  els.rate.addEventListener('change', () => {
    audio.playbackRate = parseFloat(els.rate.value);
  });

  els.volume.addEventListener('input', () => {
    audio.volume = parseFloat(els.volume.value);
  });

  els.playerWave.addEventListener('click', event => {
    if (!audio.duration) return;
    const rect = els.playerWave.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
  });

  // ---------- Edit dialog ----------

  function openEdit(id) {
    const t = tracks.find(x => x.id === id);
    if (!t) return;
    editingId = id;
    els.editName.value = t.name;
    els.editBpm.value = t.bpm || '';
    tapTimes.length = 0;
    els.tapTempo.textContent = 'Tap Tempo';
    els.editDialog.showModal();
  }

  els.editForm.addEventListener('submit', async () => {
    if (!editingId) return;
    const name = els.editName.value.trim();
    const bpm = parseFloat(els.editBpm.value) || null;

    try {
      const meta = await RiddimDB.patch(editingId, { name, bpm });
      const idx = tracks.findIndex(t => t.id === editingId);
      if (idx !== -1) tracks[idx] = meta;
      render();
      updatePlayerHeader();
    } catch (err) {
      console.error(err);
      toast('Could not save changes');
    }
    editingId = null;
  });

  els.editCancel.addEventListener('click', () => {
    editingId = null;
    els.editDialog.close();
  });

  els.editDelete.addEventListener('click', async () => {
    if (!editingId) return;
    const t = tracks.find(x => x.id === editingId);
    if (!confirm(`Delete “${t ? t.name : 'this track'}” from your library?`)) return;
    try {
      await RiddimDB.delete(editingId);
      tracks = tracks.filter(x => x.id !== editingId);
      if (currentId === editingId) {
        audio.pause();
        audio.removeAttribute('src');
        currentId = null;
        els.player.hidden = true;
      }
      render();
      toast('Track deleted');
    } catch (err) {
      console.error(err);
      toast('Could not delete track');
    }
    editingId = null;
    els.editDialog.close();
  });

  // Tap tempo — tap along with the groove, we average the intervals.
  const tapTimes = [];
  els.tapTempo.addEventListener('click', () => {
    const now = performance.now();
    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2500) {
      tapTimes.length = 0; // long pause — start a fresh measurement
    }
    tapTimes.push(now);
    if (tapTimes.length < 2) {
      els.tapTempo.textContent = 'Keep tapping…';
      return;
    }
    const recent = tapTimes.slice(-9);
    const intervals = [];
    for (let i = 1; i < recent.length; i++) intervals.push(recent[i] - recent[i - 1]);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpm = Math.round((60000 / avg) * 10) / 10;
    els.editBpm.value = bpm;
    els.tapTempo.textContent = bpm + ' BPM';
  });

  // ---------- Drag & drop ----------

  let dragDepth = 0;

  window.addEventListener('dragenter', event => {
    if (!event.dataTransfer || ![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    els.dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', event => {
    event.preventDefault();
  });

  window.addEventListener('dragleave', event => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropOverlay.hidden = true;
  });

  window.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    if (event.dataTransfer && event.dataTransfer.files.length) {
      importFiles(event.dataTransfer.files);
    }
  });

  // ---------- File picker ----------

  els.addBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files.length) importFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  // ---------- Search & sort ----------

  els.search.addEventListener('input', renderLibrary);
  els.sort.addEventListener('change', renderLibrary);

  // ---------- Keyboard ----------

  window.addEventListener('keydown', event => {
    const inField = /^(input|select|textarea)$/i.test(event.target.tagName) ||
                    els.editDialog.open;
    if (inField) return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'l' || event.key === 'L') {
      els.loopBtn.click();
    } else if (event.key === 'ArrowRight' && audio.src) {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
    } else if (event.key === 'ArrowLeft' && audio.src) {
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    }
  });

  // Redraw card waveforms when the layout changes size.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderLibrary, 150);
  });

  // ---------- Boot ----------

  async function init() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    try {
      tracks = await RiddimDB.getAllMeta();
    } catch (err) {
      console.error('Failed to open library:', err);
      toast('Could not open your library (storage unavailable)');
      tracks = [];
    }
    render();
    requestAnimationFrame(playerFrame);
    fixSeededBpm();
    seedSampleTrack();

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('Service worker registration failed:', err);
      });
    }
  }

  init();
})();
