/* Riddim Repo — cloud drum track library.
   Metadata lives in Supabase (riddim_tracks); audio lives in the private
   riddim-tracks storage bucket. IndexedDB caches audio blobs on-device
   so playback is instant and keeps working offline. */

(() => {
  'use strict';

  const sb = supabase.createClient(
    window.RIDDIM_CONFIG.supabaseUrl,
    window.RIDDIM_CONFIG.supabaseKey
  );
  const BUCKET = 'riddim-tracks';
  const META_CACHE_KEY = 'riddim-meta-cache-v1';

  // ---------- State ----------

  let tracks = [];            // track metadata (cloud rows, mapped)
  let session = null;
  let currentId = null;
  let editingId = null;
  let currentUrl = null;

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
    toolbar: $('toolbar'),
    search: $('search'),
    searchBtn: $('search-btn'),
    sort: $('sort'),
    addBtn: $('add-btn'),
    logoutBtn: $('logout-btn'),
    fileInput: $('file-input'),
    dropOverlay: $('drop-overlay'),
    player: $('player'),
    playerMarquee: $('player-marquee'),
    marqueeText: $('marquee-text'),
    playerWave: $('player-wave'),
    timeCurrent: $('time-current'),
    timeTotal: $('time-total'),
    playBtn: $('play-btn'),
    prevBtn: $('prev-btn'),
    nextBtn: $('next-btn'),
    loopBtn: $('loop-btn'),
    rate: $('rate'),
    volume: $('volume'),
    authScreen: $('auth-screen'),
    authForm: $('auth-form'),
    authPasscode: $('auth-passcode'),
    authError: $('auth-error'),
    editDialog: $('edit-dialog'),
    editForm: $('edit-form'),
    editName: $('edit-name'),
    editCategory: $('edit-category'),
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

  function formatStamp(ts) {
    const d = new Date(ts);
    return formatDate(ts) + ', ' +
           d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function cleanName(filename) {
    return filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  }

  function fileExt(filename) {
    const m = filename.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : 'wav';
  }

  let toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
  }

  // ---------- Cloud data layer ----------

  function rowToMeta(row) {
    return {
      id: row.id,
      name: row.name,
      filePath: row.file_path,
      type: row.file_type,
      size: row.size,
      duration: row.duration,
      bpm: row.bpm,
      category: row.category || 'drum',
      percussion: !!row.percussion,
      favorite: !!row.favorite,
      notes: row.notes || [],
      peaks: row.peaks,
      addedAt: Date.parse(row.added_at),
    };
  }

  async function loadLibrary() {
    try {
      const { data, error } = await sb.from('riddim_tracks')
        .select('*')
        .order('added_at', { ascending: false });
      if (error) throw error;
      tracks = data.map(rowToMeta);
      localStorage.setItem(META_CACHE_KEY, JSON.stringify(tracks));
      return true;
    } catch (err) {
      console.warn('Cloud library unavailable, using offline cache:', err);
      try {
        tracks = JSON.parse(localStorage.getItem(META_CACHE_KEY) || '[]');
      } catch { tracks = []; }
      if (tracks.length) toast('Offline — showing cached library');
      return false;
    }
  }

  async function patchTrack(id, fields) {
    const row = {};
    if ('name' in fields) row.name = fields.name;
    if ('bpm' in fields) row.bpm = fields.bpm;
    if ('category' in fields) row.category = fields.category;
    if ('percussion' in fields) row.percussion = fields.percussion;
    if ('favorite' in fields) row.favorite = fields.favorite;
    if ('notes' in fields) row.notes = fields.notes;
    const { error } = await sb.from('riddim_tracks').update(row).eq('id', id);
    if (error) throw error;
    const idx = tracks.findIndex(t => t.id === id);
    if (idx !== -1) {
      Object.assign(tracks[idx], fields);
      localStorage.setItem(META_CACHE_KEY, JSON.stringify(tracks));
    }
    return idx !== -1 ? tracks[idx] : null;
  }

  async function deleteTrack(id) {
    const t = tracks.find(x => x.id === id);
    if (t && t.filePath) {
      await sb.storage.from(BUCKET).remove([t.filePath]);
    }
    const { error } = await sb.from('riddim_tracks').delete().eq('id', id);
    if (error) throw error;
    tracks = tracks.filter(x => x.id !== id);
    localStorage.setItem(META_CACHE_KEY, JSON.stringify(tracks));
    RiddimDB.delete(id).catch(() => {});
  }

  /** Get the audio blob for a track: local cache first, cloud otherwise. */
  async function getTrackBlob(t) {
    const cached = await RiddimDB.get(t.id).catch(() => null);
    if (cached && cached.blob) return cached.blob;

    toast('Fetching from cloud…');
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(t.filePath, 3600);
    if (error) throw error;
    const res = await fetch(data.signedUrl);
    if (!res.ok) throw new Error('Download failed: ' + res.status);
    const blob = await res.blob();
    RiddimDB.put({ id: t.id, blob }).catch(() => {});
    return blob;
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

  const WAVE_COLORS = { base: 'rgba(255,255,255,0.25)', played: '#FF4D00' };
  // Playing cards are color-filled, so their bars go black.
  const PLAYING_WAVE = { base: 'rgba(0,0,0,0.4)', played: 'rgba(0,0,0,0.4)' };

  // ---------- Categories ----------

  // Each category wears a Rasta color: Drums gold, Riddims orange, Takes green.
  const CATEGORIES = [
    { key: 'drum', label: 'Drums', sec: 'sec-gold', cat: 'cat-gold', wave: 'rgba(253,200,0,0.5)' },
    { key: 'riddim', label: 'Riddims', sec: 'sec-orange', cat: 'cat-orange', wave: 'rgba(255,77,0,0.5)' },
    { key: 'take', label: 'Takes', sec: 'sec-green', cat: 'cat-green', wave: 'rgba(0,178,91,0.5)' },
  ];
  const catMeta = t => CATEGORIES.find(c => c.key === trackCategory(t)) || CATEGORIES[0];
  const trackCategory = t => t.category || 'drum';

  // Sections start collapsed; open state is remembered per device.
  const OPEN_SECTIONS_KEY = 'riddim-open-sections-v1';
  let openSections = {};
  try { openSections = JSON.parse(localStorage.getItem(OPEN_SECTIONS_KEY) || '{}'); } catch {}
  function toggleSection(key) {
    openSections[key] = !openSections[key];
    localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(openSections));
    renderLibrary();
  }

  // ---------- Import ----------

  const AUDIO_EXT = /\.(wav|mp3|ogg|oga|flac|m4a|aac|aiff?|webm)$/i;

  function isAudioFile(file) {
    return file.type.startsWith('audio/') || AUDIO_EXT.test(file.name);
  }

  /** Decode + upload + insert. Returns the new track meta. */
  async function importOneFile(file, category, presets) {
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

    const id = crypto.randomUUID();
    const type = file.type || 'audio/wav';
    const blob = new Blob([arrayBuffer], { type });
    const path = `${session.user.id}/${id}.${fileExt(file.name)}`;

    const { error: upErr } = await sb.storage.from(BUCKET)
      .upload(path, blob, { contentType: type });
    if (upErr) throw upErr;

    const row = {
      id,
      name: (presets && presets.name) || cleanName(file.name),
      file_path: path,
      file_type: type,
      size: blob.size,
      duration,
      peaks,
      bpm: (presets && presets.bpm) || null,
      category: category || 'drum',
      percussion: !!(presets && presets.percussion),
      notes: (presets && presets.notes) || [],
    };
    if (presets && presets.addedAt) row.added_at = new Date(presets.addedAt).toISOString();

    const { data, error } = await sb.from('riddim_tracks').insert(row).select().single();
    if (error) {
      sb.storage.from(BUCKET).remove([path]).catch(() => {});
      throw error;
    }

    RiddimDB.put({ id, blob }).catch(() => {});
    const meta = rowToMeta(data);
    tracks.push(meta);
    localStorage.setItem(META_CACHE_KEY, JSON.stringify(tracks));
    return meta;
  }

  /** New uploads land in Drums; re-categorize via Edit to move them. */
  async function importFiles(fileList) {
    if (!session) { toast('Log in first'); return; }
    const files = Array.from(fileList).filter(isAudioFile);
    const skipped = fileList.length - files.length;
    if (!files.length) {
      toast('No audio files found — drop .wav or .mp3 tracks');
      return;
    }

    toast(`Uploading ${files.length} track${files.length > 1 ? 's' : ''}…`);
    let imported = 0;

    for (const file of files) {
      try {
        await importOneFile(file, 'drum');
        imported++;
      } catch (err) {
        console.error('Import failed:', file.name, err);
        toast(`Couldn't upload ${file.name}`);
      }
    }

    render();
    if (imported) {
      toast(`Added ${imported} track${imported > 1 ? 's' : ''}` +
            (skipped > 0 ? ` (skipped ${skipped} non-audio)` : ''));
    }
  }

  /** Move any pre-cloud local tracks (with metadata in IndexedDB) up to the cloud. */
  async function migrateLocalLibrary() {
    let records = [];
    try { records = await RiddimDB.getAllRecords(); } catch { return; }
    const legacy = records.filter(r => r.name && r.blob);
    if (!legacy.length) return;

    toast(`Syncing ${legacy.length} local track${legacy.length > 1 ? 's' : ''} to the cloud…`);
    for (const rec of legacy) {
      try {
        const dupe = tracks.find(t => t.name === rec.name && t.size === rec.size);
        if (!dupe) {
          let bpm = rec.bpm || null;
          if (rec.fileName === 'Zuchinni Dryne.wav' && bpm === 130) bpm = 65;
          const file = new File([rec.blob], rec.fileName || (rec.name + '.wav'),
                                { type: rec.type || 'audio/wav' });
          await importOneFile(file, rec.category || 'drum', {
            name: rec.name,
            bpm,
            percussion: !!rec.percussion,
            notes: rec.notes || [],
            addedAt: rec.addedAt,
          });
        }
        await RiddimDB.delete(rec.id);
      } catch (err) {
        console.error('Migration failed for', rec.name, err);
      }
    }
    render();
    toast('Local tracks synced to the cloud');
  }

  /** Ship-with-the-app starter groove — only for a brand-new empty library. */
  async function seedSampleTrack() {
    if (tracks.length) return;
    try {
      const res = await fetch('samples/zuchinni-dryne.wav');
      if (!res.ok) return;
      const blob = await res.blob();
      const file = new File([blob], 'Zuchinni Dryne.wav', { type: 'audio/wav' });
      await importOneFile(file, 'drum', { bpm: 65 });
      render();
    } catch (err) {
      console.warn('Sample seed skipped:', err);
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
        case 'bpm': va = a.bpm || Infinity; vb = b.bpm || Infinity; break;
        default: va = a.addedAt; vb = b.addedAt;
      }
      return va < vb ? -sign : va > vb ? sign : 0;
    });
    return list;
  }

  function displayOrder() {
    const list = visibleTracks();
    return CATEGORIES.flatMap(cat => list.filter(t => trackCategory(t) === cat.key));
  }

  function renderLibrary() {
    const list = visibleTracks();
    els.library.innerHTML = '';
    els.emptyState.style.display = (session && tracks.length === 0) ? '' : 'none';

    const searching = els.search.value.trim().length > 0;

    for (const cat of CATEGORIES) {
      const group = list.filter(t => trackCategory(t) === cat.key);
      if (!group.length) continue;
      // Favorites float to the top of their section.
      group.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));

      const isOpen = searching || !!openSections[cat.key];

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'section-head ' + cat.sec + (isOpen ? ' open' : '');
      head.setAttribute('aria-expanded', String(isOpen));
      const title = document.createElement('h2');
      title.innerHTML = '<span class="chev"></span>';
      title.appendChild(document.createTextNode(cat.label));
      const count = document.createElement('span');
      count.className = 'section-count';
      count.textContent = String(group.length).padStart(2, '0') + ' TRK';
      head.append(title, count);
      head.addEventListener('click', () => toggleSection(cat.key));
      els.library.appendChild(head);

      if (isOpen) {
        const grid = document.createElement('div');
        grid.className = 'library-grid ' + cat.cat;
        for (const t of group) grid.appendChild(buildCard(t));
        els.library.appendChild(grid);
      }
    }
  }

  function buildCard(t) {
      const meta = catMeta(t);
      const card = document.createElement('article');
      card.className = 'track-card ' + meta.cat + (t.id === currentId ? ' playing' : '');
      card.dataset.id = t.id;

      const front = document.createElement('div');
      front.className = 'card-front';

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

      const starBtn = document.createElement('button');
      starBtn.type = 'button';
      starBtn.className = 'track-star' + (t.favorite ? ' starred' : '');
      starBtn.title = t.favorite ? 'Unfavorite' : 'Favorite';
      starBtn.setAttribute('aria-label', 'Favorite ' + t.name);
      starBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
      starBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const next = !t.favorite;
        starBtn.classList.toggle('starred', next);
        try {
          await patchTrack(t.id, { favorite: next });
          t.favorite = next;
        } catch (err) {
          console.error(err);
          starBtn.classList.toggle('starred', !next);
          toast('Could not save');
        }
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'track-edit';
      editBtn.textContent = 'Edit';
      editBtn.title = 'Edit name, type, and BPM';
      editBtn.setAttribute('aria-label', 'Edit ' + t.name);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'track-actions-row';
      actionsRow.appendChild(starBtn);

      head.append(playBtn, titles, actionsRow);
      front.appendChild(head);

      if (t.peaks) {
        const canvas = document.createElement('canvas');
        canvas.className = 'track-wave';
        front.appendChild(canvas);
        const waveColors = t.id === currentId ? PLAYING_WAVE : { base: meta.wave, played: meta.wave };
        requestAnimationFrame(() => drawWave(canvas, t.peaks, 0, waveColors));
      }

      const foot = document.createElement('div');
      foot.className = 'card-foot';

      // Percussion flag only applies to drum tracks.
      if (trackCategory(t) === 'drum') {
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
            await patchTrack(t.id, { percussion: percBox.checked });
          } catch (err) {
            console.error(err);
            percBox.checked = !percBox.checked;
            toast('Could not save');
          }
        });
        foot.appendChild(percLabel);
      } else {
        foot.appendChild(document.createElement('span'));
      }
      foot.appendChild(editBtn);
      front.appendChild(foot);

      // Pencil: flip the card over to its notes side.
      const noteBtn = document.createElement('button');
      noteBtn.type = 'button';
      noteBtn.className = 'note-btn';
      noteBtn.title = 'Notes';
      noteBtn.setAttribute('aria-label', 'Notes for ' + t.name);
      noteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>';
      actionsRow.appendChild(noteBtn);

      // Back of the card: saved notes + entry box.
      const back = document.createElement('div');
      back.className = 'card-back';

      const noteHead = document.createElement('div');
      noteHead.className = 'note-head';
      const noteTitle = document.createElement('h4');
      noteTitle.textContent = 'Notes';
      const noteClose = document.createElement('button');
      noteClose.type = 'button';
      noteClose.className = 'note-close';
      noteClose.textContent = '✕';
      noteClose.setAttribute('aria-label', 'Close notes');
      noteHead.append(noteTitle, noteClose);

      const noteList = document.createElement('div');
      noteList.className = 'note-list';
      function noteEntryEl(n) {
        const entry = document.createElement('div');
        entry.className = 'note-entry';
        const stamp = document.createElement('div');
        stamp.className = 'note-stamp';
        stamp.textContent = formatStamp(n.at);
        const body = document.createElement('div');
        body.className = 'note-text';
        body.textContent = n.text;
        entry.append(stamp, body);
        return entry;
      }
      for (const n of [...(t.notes || [])].reverse()) noteList.appendChild(noteEntryEl(n));

      const noteRow = document.createElement('div');
      noteRow.className = 'note-row';
      const noteInput = document.createElement('textarea');
      noteInput.className = 'note-input';
      noteInput.rows = 2;
      noteInput.placeholder = 'Write a note…';
      const noteSave = document.createElement('button');
      noteSave.type = 'button';
      noteSave.className = 'note-save';
      noteSave.textContent = 'Save';
      noteRow.append(noteInput, noteSave);

      back.append(noteHead, noteList, noteRow);
      back.addEventListener('click', e => e.stopPropagation());

      noteBtn.addEventListener('click', e => {
        e.stopPropagation();
        card.classList.add('flipped');
        noteInput.focus();
      });
      noteClose.addEventListener('click', () => card.classList.remove('flipped'));

      async function saveNote() {
        const text = noteInput.value.trim();
        if (!text) return;
        const entry = { text, at: Date.now() };
        try {
          const existing = tracks.find(x => x.id === t.id);
          const notes = [...((existing && existing.notes) || []), entry];
          await patchTrack(t.id, { notes });
          noteList.prepend(noteEntryEl(entry));
          noteInput.value = '';
        } catch (err) {
          console.error(err);
          toast('Could not save note');
        }
      }
      noteSave.addEventListener('click', saveNote);
      noteInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          saveNote();
        }
      });

      card.append(front, back);

      card.addEventListener('click', event => {
        if (card.classList.contains('flipped')) return;
        if (event.target === editBtn || event.target === noteBtn || event.target === starBtn) return;
        if (t.id === currentId) {
          togglePlay();
        } else {
          playTrack(t.id);
        }
      });
      editBtn.addEventListener('click', () => openEdit(t.id));

      return card;
  }

  function render() {
    renderLibrary();
  }

  // ---------- Player ----------

  function currentTrack() {
    return tracks.find(t => t.id === currentId) || null;
  }

  async function playTrack(id) {
    const t = tracks.find(x => x.id === id);
    if (!t) { toast('Track not found'); return; }

    let blob;
    try {
      blob = await getTrackBlob(t);
    } catch (err) {
      console.error('Could not load audio:', err);
      toast('Could not load audio (offline?)');
      return;
    }

    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(blob);
    currentId = id;

    audio.src = currentUrl;
    audio.playbackRate = parseFloat(els.rate.value);
    try {
      await audio.play();
    } catch (err) {
      console.warn('Playback failed:', err);
    }

    els.player.hidden = false;
    els.timeTotal.textContent = formatTime(t.duration || audio.duration);
    updateMarquee();
    updateMediaSession();
    render();
  }

  function togglePlay() {
    if (!currentId) {
      const list = displayOrder();
      if (list.length) playTrack(list[0].id);
      return;
    }
    if (audio.paused) audio.play();
    else audio.pause();
  }

  function step(direction) {
    const list = displayOrder();
    if (!list.length) return;
    const idx = list.findIndex(t => t.id === currentId);
    const next = idx === -1
      ? (direction > 0 ? list[0] : list[list.length - 1])
      : list[(idx + direction + list.length) % list.length];
    playTrack(next.id);
  }

  function updateMarquee() {
    const t = currentTrack();
    if (!t) return;
    const bits = ['NOW PLAYING', t.name.toUpperCase()];
    if (t.bpm) bits.push(Math.round(t.bpm) + ' BPM');
    bits.push('LOOP ' + (audio.loop ? 'ON' : 'OFF'));
    els.marqueeText.textContent = (bits.join(' — ') + ' — ').repeat(6);
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

  audio.addEventListener('play', () => {
    syncPlayButtons();
    els.playerMarquee.classList.remove('paused');
  });
  audio.addEventListener('pause', () => {
    syncPlayButtons();
    els.playerMarquee.classList.add('paused');
  });
  audio.addEventListener('ended', () => step(1));

  els.playBtn.addEventListener('click', togglePlay);
  els.prevBtn.addEventListener('click', () => step(-1));
  els.nextBtn.addEventListener('click', () => step(1));

  els.loopBtn.addEventListener('click', () => {
    audio.loop = !audio.loop;
    els.loopBtn.classList.toggle('toggled', audio.loop);
    updateMarquee();
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
    els.editCategory.value = trackCategory(t);
    els.editBpm.value = t.bpm || '';
    tapTimes.length = 0;
    els.tapTempo.textContent = 'Tap Tempo';
    els.editDialog.showModal();
  }

  els.editForm.addEventListener('submit', async () => {
    if (!editingId) return;
    const name = els.editName.value.trim();
    const bpm = parseFloat(els.editBpm.value) || null;
    const category = els.editCategory.value;

    try {
      await patchTrack(editingId, { name, bpm, category });
      render();
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
      await deleteTrack(editingId);
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
      tapTimes.length = 0;
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

  // ---------- File picker, search toggle, sort ----------

  els.addBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files.length) importFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  els.searchBtn.addEventListener('click', () => {
    els.toolbar.hidden = !els.toolbar.hidden;
    if (!els.toolbar.hidden) {
      els.search.focus();
    } else {
      els.search.value = '';
      renderLibrary();
    }
  });

  els.search.addEventListener('input', renderLibrary);
  els.sort.addEventListener('change', renderLibrary);

  // ---------- Auth ----------

  function setAuthed(s) {
    session = s;
    els.authScreen.hidden = !!s;
    els.logoutBtn.hidden = !s;
  }

  // Passcode login: the code unlocks a single shared library account.
  els.authForm.addEventListener('submit', async event => {
    event.preventDefault();
    els.authError.hidden = true;
    const btn = els.authForm.querySelector('.auth-submit');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const code = els.authPasscode.value.trim();
      const { data, error } = await sb.auth.signInWithPassword({
        email: 'door@riddimrepo.local',
        password: `riddim-door-${code}-zx7`,
      });
      if (error) throw new Error('Wrong passcode');
      setAuthed(data.session);
      await bootLibrary();
    } catch (err) {
      console.error(err);
      els.authError.textContent = err.message || 'Wrong passcode';
      els.authError.hidden = false;
      els.authPasscode.value = '';
      els.authPasscode.focus();
    }
    btn.disabled = false;
    btn.textContent = 'Enter';
  });

  els.logoutBtn.addEventListener('click', async () => {
    await sb.auth.signOut().catch(() => {});
    setAuthed(null);
    tracks = [];
    currentId = null;
    audio.pause();
    audio.removeAttribute('src');
    els.player.hidden = true;
    render();
  });

  // ---------- Keyboard ----------

  window.addEventListener('keydown', event => {
    const inField = /^(input|select|textarea)$/i.test(event.target.tagName) ||
                    els.editDialog.open || !els.authScreen.hidden;
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

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderLibrary, 150);
  });

  // ---------- Boot ----------

  async function bootLibrary() {
    const online = await loadLibrary();
    render();
    if (online) {
      await migrateLocalLibrary();
      await seedSampleTrack();
      render();
    }
  }

  async function init() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    requestAnimationFrame(playerFrame);

    const { data } = await sb.auth.getSession();
    setAuthed(data.session);
    if (data.session) {
      await bootLibrary();
    }

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('Service worker registration failed:', err);
      });
    }
  }

  init();
})();
