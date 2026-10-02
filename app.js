const $ = (id) => document.getElementById(id);
const STORE_KEY = 'soundboard.spotify.v1';
const DECK_KEY = 'soundboard.deck.v1';
const DB_NAME = 'soundboard-audio';
const MIGRATION_KEY = 'soundboard.server-migrated.v1';
let spotifyLinks = [];
let selectedSpotify = null;
let spotifyPlaying = false;
let clips = [];
const active = new Map();
let deck = Array(16).fill(null);
let editingPad = null;
let ready = false;
let saveQueue = Promise.resolve();
let saveNumber = 0;

function persistLibrary() {
  if (!ready) return saveQueue;
  const snapshot = {
    spotify: structuredClone(spotifyLinks),
    deck: structuredClone(deck),
    clipVolumes: Object.fromEntries(clips.map((clip) => [clip.id, clipVolume(clip)])),
  };
  const number = ++saveNumber;
  $('save-status').textContent = 'Saving…';
  saveQueue = saveQueue.catch(() => {}).then(() => api('library', snapshot));
  saveQueue.then(() => { if (number === saveNumber) $('save-status').textContent = 'Saved on this computer'; }, (error) => {
    if (number === saveNumber) $('save-status').textContent = `Save failed: ${error.message}`;
  });
  return saveQueue;
}

function saveDeck() {
  renderDeck();
  return persistLibrary();
}

function firstEmptyPad() { return deck.findIndex((pad) => !pad); }

function assignNewSource(type, ref, label) {
  const index = firstEmptyPad();
  if (index < 0) return;
  deck[index] = {type, ref, label: label.slice(0, 40), loop: false};
  saveDeck();
}

function sourceFor(pad) {
  if (!pad) return null;
  return pad.type === 'spotify' ? spotifyLinks.find((item) => item.uri === pad.ref) : clips.find((item) => item.id === pad.ref);
}

function renderDeck() {
  const grid = $('deck-grid');
  grid.replaceChildren();
  deck.forEach((pad, index) => {
    const source = sourceFor(pad);
    const filled = Boolean(pad && source);
    const playing = filled && (pad.type === 'spotify' ? selectedSpotify === pad.ref && spotifyPlaying : [...active.values()].some((entry) => entry.slot === index));
    const card = document.createElement('div');
    card.className = `deck-pad ${filled ? (pad.type === 'spotify' ? 'spotify-pad' : 'clip-pad') : 'empty-pad'}${playing ? ' playing' : ''}`;
    const trigger = document.createElement('button');
    trigger.className = 'pad-trigger';
    trigger.type = 'button';
    trigger.disabled = !ready;
    const number = document.createElement('span');
    number.className = 'pad-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const icon = document.createElement('span');
    icon.className = 'pad-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = !filled ? '+' : pad.type === 'spotify' ? (pad.ref.includes(':playlist:') ? '♫' : '♪') : (pad.loop ? '↻' : '◖))');
    const name = document.createElement('span');
    name.className = 'pad-name';
    name.textContent = filled ? (pad.label || source.name) : 'Assign a cue';
    const kind = document.createElement('span');
    kind.className = 'pad-kind';
    kind.textContent = !filled ? 'EMPTY PAD' : pad.type === 'spotify' ? (pad.ref.includes(':playlist:') ? 'SPOTIFY PLAYLIST' : 'SPOTIFY SONG') : (pad.loop ? (playing ? 'LOOPING · TAP TO STOP' : 'LOOPING SOUND') : 'SOUND EFFECT');
    trigger.setAttribute('aria-label', filled ? `${playing && pad.loop ? 'Stop' : 'Play'} ${pad.label || source.name}` : `Assign pad ${index + 1}`);
    trigger.append(number, icon, name, kind);
    trigger.addEventListener('click', () => {
      if (!filled) return openPadDialog(index);
      if (pad.type === 'spotify') return playSpotify(source, true);
      if (pad.loop) {
        const running = [...active.entries()].filter(([, entry]) => entry.slot === index);
        if (running.length) return running.forEach(([id]) => stopClip(id));
      }
      playClip(source, {slot: index, loop: Boolean(pad.loop)});
    });
    card.append(trigger);
    if (filled) {
      const edit = document.createElement('button');
      edit.className = 'pad-edit';
      edit.type = 'button';
      edit.disabled = !ready;
      edit.textContent = '✎';
      edit.title = `Edit pad ${index + 1}`;
      edit.setAttribute('aria-label', `Edit pad ${index + 1}`);
      edit.addEventListener('click', () => openPadDialog(index));
      card.append(edit);
    }
    grid.append(card);
  });
}

function openPadDialog(index) {
  editingPad = index;
  const pad = deck[index];
  const select = $('pad-source');
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a saved song, playlist, or clip';
  select.append(placeholder);
  for (const [title, items, prefix, key] of [
    ['Spotify music', spotifyLinks, 'spotify|', 'uri'],
    ['Local sound clips', clips, 'clip|', 'id'],
  ]) {
    if (!items.length) continue;
    const group = document.createElement('optgroup');
    group.label = title;
    for (const item of items) {
      const option = document.createElement('option');
      option.value = prefix + item[key];
      option.textContent = item.name;
      group.append(option);
    }
    select.append(group);
  }
  select.value = pad ? `${pad.type}|${pad.ref}` : '';
  $('pad-label').value = pad?.label || '';
  $('pad-loop').checked = Boolean(pad?.loop);
  $('pad-dialog-title').textContent = `Set up pad ${String(index + 1).padStart(2, '0')}`;
  $('pad-clear').hidden = !pad;
  $('pad-no-sources').hidden = spotifyLinks.length + clips.length > 0;
  $('pad-save').disabled = spotifyLinks.length + clips.length === 0;
  updatePadLoop();
  $('pad-dialog').showModal();
}

function updatePadLoop() {
  const isClip = $('pad-source').value.startsWith('clip|');
  $('pad-loop-wrap').hidden = !isClip;
  if (!isClip) $('pad-loop').checked = false;
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = !message;
}

function spotifyUri(input) {
  const raw = input.trim();
  let match = raw.match(/^spotify:(track|playlist):([A-Za-z0-9]{22})$/i);
  if (!match) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') return null;
      match = url.pathname.match(/^(?:\/intl-[a-z]{2,5})?\/(track|playlist)\/([A-Za-z0-9]{22})(?:\/|$)/i);
    } catch { return null; }
  }
  return match ? `spotify:${match[1].toLowerCase()}:${match[2]}` : null;
}

function saveSpotify() {
  renderSpotify();
  renderDeck();
  return persistLibrary();
}

function renderSpotify() {
  $('spotify-count').textContent = `${spotifyLinks.length} saved`;
  const list = $('spotify-list');
  list.replaceChildren();
  if (!spotifyLinks.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'No Spotify links yet. Add a song or playlist above.';
    list.append(empty);
    return;
  }
  for (const item of spotifyLinks) {
    const row = document.createElement('div');
    row.className = 'saved-item' + (selectedSpotify === item.uri ? ' selected' : '');
    const icon = document.createElement('div');
    icon.className = 'saved-icon';
    icon.textContent = item.uri.includes(':playlist:') ? '≡' : '♫';
    const copy = document.createElement('div');
    copy.className = 'saved-copy';
    const name = document.createElement('strong');
    name.textContent = item.name;
    name.title = item.name;
    const type = document.createElement('span');
    type.textContent = item.uri.includes(':playlist:') ? 'PLAYLIST' : 'TRACK';
    copy.append(name, type);
    const play = document.createElement('button');
    play.className = 'load-button';
    play.textContent = 'Play';
    play.title = `Play ${item.name} in Spotify`;
    play.addEventListener('click', () => playSpotify(item));
    const remove = document.createElement('button');
    remove.className = 'icon-button';
    remove.textContent = '×';
    remove.title = `Remove ${item.name}`;
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', () => {
      spotifyLinks = spotifyLinks.filter((link) => link.uri !== item.uri);
      if (selectedSpotify === item.uri) selectedSpotify = null;
      deck = deck.map((pad) => pad?.type === 'spotify' && pad.ref === item.uri ? null : pad);
      saveDeck();
      saveSpotify();
    });
    row.append(icon, copy, play, remove);
    list.append(row);
  }
}

async function api(path, body) {
  const options = body ? { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) } : {};
  const response = await fetch(`/api/${path}`, options);
  let result;
  try { result = await response.json(); } catch { throw new Error('The local soundboard server is unavailable. Start it with ./start.sh.'); }
  if (!response.ok) throw new Error(result.error || 'Soundboard request failed.');
  return result;
}

async function playSpotify(item, fromDeck = false) {
  showError('spotify-error', '');
  showError('deck-error', '');
  try {
    await api('spotify/open', {uri: item.uri, background: fromDeck});
    selectedSpotify = item.uri;
    renderSpotify();
    renderDeck();
    refreshSpotify();
  } catch (error) { showError('spotify-error', error.message); showError('deck-error', error.message); }
}

async function spotifyCommand(command) {
  showError('spotify-error', '');
  showError('deck-error', '');
  try {
    await api('spotify/control', {command});
    setTimeout(refreshSpotify, 250);
  } catch (error) { showError('spotify-error', error.message); showError('deck-error', error.message); }
}

async function refreshSpotify() {
  try {
    const state = await api('spotify/status');
    spotifyPlaying = state.playing;
    $('deck-pause-music').disabled = !state.connected || !state.playing;
    renderDeck();
    $('spotify-indicator').classList.toggle('disconnected', !state.connected);
    $('spotify-connection').textContent = state.connected ? 'SPOTIFY CONNECTED' : 'SPOTIFY NOT RUNNING';
    $('spotify-track').textContent = state.title || (state.connected ? 'Ready to play' : 'Open Spotify to connect');
    $('spotify-artist').textContent = state.artist || (state.connected ? 'Choose a saved link or use the controls.' : 'Your saved links can launch the app.');
    $('spotify-toggle').textContent = state.playing ? 'Ⅱ' : '▶';
    $('spotify-toggle').setAttribute('aria-label', state.playing ? 'Pause Spotify' : 'Play Spotify');
    $('spotify-player-note').textContent = state.connected ? 'Spotify audio plays in the desktop app. Local clips can play over it.' : 'Play a saved link to launch Spotify, or open the app yourself.';
  } catch {
    spotifyPlaying = false;
    $('deck-pause-music').disabled = true;
    renderDeck();
    $('spotify-indicator').classList.add('disconnected');
    $('spotify-connection').textContent = 'LOCAL SERVER UNAVAILABLE';
    $('spotify-track').textContent = 'Start the soundboard server';
    $('spotify-artist').textContent = 'Run ./start.sh from this folder.';
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('clips', {keyPath: 'id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('clips', mode);
    const request = operation(transaction.objectStore('clips'));
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Storage transaction was cancelled.'));
  });
}

function fileSize(bytes) {
  return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

function clipVolume(clip) {
  return Number.isInteger(clip.volume) && clip.volume >= 0 && clip.volume <= 100 ? clip.volume : 100;
}

function renderClips() {
  $('clip-count').textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'}`;
  const grid = $('clip-grid');
  grid.replaceChildren();
  if (!clips.length) {
    const empty = document.createElement('div');
    empty.className = 'clip-empty';
    empty.textContent = 'Your soundboard is empty. Add an audio file to make your first button.';
    grid.append(empty);
    return;
  }
  for (const clip of clips) {
    const card = document.createElement('div');
    card.className = 'clip-card';
    const top = document.createElement('div');
    top.className = 'clip-top';
    const symbol = document.createElement('div');
    symbol.className = 'clip-symbol';
    symbol.textContent = '◖))';
    top.append(symbol);
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'clip-name';
    name.textContent = clip.name;
    name.title = clip.name;
    const meta = document.createElement('div');
    meta.className = 'clip-meta';
    meta.textContent = fileSize(clip.size);
    info.append(name, meta);
    const volumeControl = document.createElement('div');
    volumeControl.className = 'clip-volume';
    const volumeLabel = document.createElement('label');
    volumeLabel.htmlFor = `volume-${clip.id}`;
    volumeLabel.textContent = 'Volume';
    const volumeValue = document.createElement('output');
    volumeValue.htmlFor = `volume-${clip.id}`;
    volumeValue.textContent = `${clipVolume(clip)}%`;
    const volumeSlider = document.createElement('input');
    volumeSlider.id = `volume-${clip.id}`;
    volumeSlider.type = 'range';
    volumeSlider.min = '0';
    volumeSlider.max = '100';
    volumeSlider.step = '1';
    volumeSlider.value = String(clipVolume(clip));
    volumeSlider.addEventListener('input', () => {
      clip.volume = Number(volumeSlider.value);
      volumeValue.textContent = `${clip.volume}%`;
      for (const entry of active.values()) {
        if (entry.clipId === clip.id) entry.audio.volume = clip.volume / 100;
      }
    });
    volumeSlider.addEventListener('change', () => persistLibrary());
    volumeControl.append(volumeLabel, volumeValue, volumeSlider);
    const actions = document.createElement('div');
    actions.className = 'clip-actions';
    const play = document.createElement('button');
    play.className = 'clip-play';
    play.textContent = '▶ Play clip';
    play.addEventListener('click', () => playClip(clip));
    const remove = document.createElement('button');
    remove.className = 'clip-remove';
    remove.textContent = '×';
    remove.title = `Remove ${clip.name}`;
    remove.setAttribute('aria-label', `Remove ${clip.name}`);
    remove.addEventListener('click', async () => {
      try {
        await saveQueue.catch(() => {});
        await api('clips/delete', {id: clip.id});
        clips = clips.filter((item) => item.id !== clip.id);
        deck = deck.map((pad) => pad?.type === 'clip' && pad.ref === clip.id ? null : pad);
        saveDeck();
        renderClips();
      } catch (error) { showError('file-error', `Could not remove ${clip.name}: ${error.message}`); }
    });
    actions.append(play, remove);
    card.append(top, info, volumeControl, actions);
    grid.append(card);
  }
}

async function addFiles(files) {
  showError('file-error', '');
  if (!ready) return showError('file-error', 'Saved sounds are unavailable. Start ./start.sh and refresh the page.');
  const errors = [];
  for (const file of files) {
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name)) {
      errors.push(`${file.name} is not an audio file.`);
      continue;
    }
    const id = crypto.randomUUID();
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
    try {
      const clip = await uploadClip(id, name, Date.now(), file);
      clips.push(clip);
      assignNewSource('clip', clip.id, clip.name);
    } catch (error) { errors.push(`Could not save ${file.name}: ${error.message}`); }
  }
  renderClips();
  showError('file-error', errors.join(' '));
}

async function uploadClip(id, name, created, blob) {
  const response = await fetch(`/api/clips/upload/${id}`, {
    method: 'POST',
    headers: {'Content-Type': blob.type || 'application/octet-stream', 'X-Clip-Name': encodeURIComponent(name), 'X-Clip-Created': String(created)},
    body: blob,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not save audio file.');
  return result;
}

function stopClip(id) {
  const entry = active.get(id);
  if (!entry) return;
  entry.audio.pause();
  entry.audio.removeAttribute('src');
  entry.audio.load();
  active.delete(id);
  renderActive();
  renderDeck();
}

function playClip(clip, options = {}) {
  showError('file-error', '');
  const id = crypto.randomUUID();
  const url = `/api/clips/${clip.id}`;
  const audio = new Audio(url);
  audio.loop = Boolean(options.loop);
  audio.volume = clipVolume(clip) / 100;
  active.set(id, {audio, url, clipId: clip.id, name: clip.name, slot: options.slot, loop: audio.loop});
  audio.addEventListener('ended', () => stopClip(id), {once: true});
  audio.addEventListener('error', () => { stopClip(id); showError('file-error', `Could not play ${clip.name}. This browser may not support its format.`); }, {once: true});
  audio.play().catch((error) => { stopClip(id); showError('file-error', `Could not play ${clip.name}: ${error.message}`); });
  renderActive();
  renderDeck();
}

function renderActive() {
  const list = $('active-list');
  list.replaceChildren();
  $('active-count').textContent = `${active.size} ACTIVE`;
  $('stop-all').disabled = active.size === 0;
  $('deck-stop-local').disabled = active.size === 0;
  if (!active.size) {
    const empty = document.createElement('div');
    empty.className = 'empty-active';
    empty.textContent = 'No local clips playing. Your next sound is one tap away.';
    list.append(empty);
    return;
  }
  for (const [id, entry] of active) {
    const row = document.createElement('div');
    row.className = 'active-row';
    const bars = document.createElement('div');
    bars.className = 'playing-bars';
    bars.setAttribute('aria-hidden', 'true');
    bars.innerHTML = '<i></i><i></i><i></i>';
    const name = document.createElement('div');
    name.className = 'active-name';
    name.textContent = entry.name;
    const stop = document.createElement('button');
    stop.className = 'active-stop';
    stop.textContent = 'Stop';
    stop.setAttribute('aria-label', `Stop ${entry.name}`);
    stop.addEventListener('click', () => stopClip(id));
    row.append(bars, name, stop);
    list.append(row);
  }
}

async function migrateBrowserData() {
  try {
    if (localStorage.getItem(MIGRATION_KEY)) return;
  } catch { return; }
  let oldLinks = [];
  let oldDeck = null;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (Array.isArray(saved)) oldLinks = saved.filter((item) => item && spotifyUri(item.uri) === item.uri && typeof item.name === 'string' && item.name.length > 0);
    const pads = JSON.parse(localStorage.getItem(DECK_KEY) || 'null');
    if (Array.isArray(pads) && pads.length === 16) oldDeck = pads;
  } catch { /* Keep any server-saved items if older browser data is malformed. */ }
  for (const item of oldLinks) {
    if (!spotifyLinks.some((link) => link.uri === item.uri)) spotifyLinks.push({uri: item.uri, name: item.name.slice(0, 80)});
  }
  let migratedAllClips = true;
  try {
    const oldDb = await openDatabase();
    const oldClips = await dbRequest(oldDb, 'readonly', (store) => store.getAll());
    for (const oldClip of oldClips) {
      if (clips.some((clip) => clip.id === oldClip.id)) continue;
      try {
        const clip = await uploadClip(oldClip.id, oldClip.name.slice(0, 80), oldClip.created || Date.now(), oldClip.blob);
        clips.push(clip);
      } catch (error) {
        migratedAllClips = false;
        showError('file-error', `Could not import ${oldClip.name}: ${error.message}`);
      }
    }
    oldDb.close();
  } catch (error) {
    migratedAllClips = false;
    showError('file-error', `Could not read older browser audio: ${error.message}`);
  }
  if (oldDeck) {
    oldDeck.forEach((pad, index) => {
      if (deck[index] || !pad || !['spotify', 'clip'].includes(pad.type) || typeof pad.ref !== 'string' || typeof pad.label !== 'string') return;
      if (sourceFor(pad)) deck[index] = {type: pad.type, ref: pad.ref, label: pad.label.slice(0, 40), loop: pad.type === 'clip' && Boolean(pad.loop)};
    });
  } else {
    for (const [type, items, key] of [['spotify', spotifyLinks, 'uri'], ['clip', clips, 'id']]) {
      for (const item of items) {
        if (deck.some((pad) => pad?.type === type && pad.ref === item[key])) continue;
        const index = firstEmptyPad();
        if (index < 0) break;
        deck[index] = {type, ref: item[key], label: item.name.slice(0, 40), loop: false};
      }
    }
  }
  await api('library', {spotify: spotifyLinks, deck});
  if (migratedAllClips) {
    try { localStorage.setItem(MIGRATION_KEY, '1'); } catch { /* Server copy is still saved. */ }
  }
}

async function init() {
  renderDeck();
  renderSpotify();
  renderClips();
  $('spotify-form').addEventListener('submit', (event) => {
    event.preventDefault();
    showError('spotify-error', '');
    if (!ready) return showError('spotify-error', 'Saved sounds are unavailable. Start ./start.sh and refresh the page.');
    const uri = spotifyUri($('spotify-url').value);
    if (!uri) return showError('spotify-error', 'Paste an open.spotify.com track or playlist link, or a Spotify track/playlist URI.');
    if (spotifyLinks.some((item) => item.uri === uri)) return showError('spotify-error', 'That Spotify link is already saved.');
    const name = $('spotify-name').value.trim() || (uri.includes(':playlist:') ? 'Spotify playlist' : 'Spotify song');
    spotifyLinks.push({uri, name});
    assignNewSource('spotify', uri, name);
    saveSpotify();
    $('spotify-form').reset();
  });
  $('spotify-prev').addEventListener('click', () => spotifyCommand('previous'));
  $('spotify-toggle').addEventListener('click', () => spotifyCommand('playpause'));
  $('spotify-next').addEventListener('click', () => spotifyCommand('next'));
  $('deck-pause-music').addEventListener('click', () => { if (spotifyPlaying) spotifyCommand('playpause'); });
  $('deck-stop-local').addEventListener('click', () => { for (const id of [...active.keys()]) stopClip(id); });
  $('pad-close').addEventListener('click', () => $('pad-dialog').close());
  $('pad-cancel').addEventListener('click', () => $('pad-dialog').close());
  $('pad-source').addEventListener('change', () => {
    updatePadLoop();
    const [type, ref] = $('pad-source').value.split('|');
    const source = sourceFor({type, ref});
    if (source && !$('pad-label').value.trim()) $('pad-label').value = source.name.slice(0, 40);
  });
  $('pad-clear').addEventListener('click', () => {
    deck[editingPad] = null;
    saveDeck();
    $('pad-dialog').close();
  });
  $('pad-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const [type, ref] = $('pad-source').value.split('|');
    const source = sourceFor({type, ref});
    if (!source) return;
    deck[editingPad] = {type, ref, label: $('pad-label').value.trim() || source.name.slice(0, 40), loop: type === 'clip' && $('pad-loop').checked};
    saveDeck();
    $('pad-dialog').close();
  });
  refreshSpotify();
  setInterval(refreshSpotify, 3000);

  $('choose-files').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (event) => { addFiles([...event.target.files]); event.target.value = ''; });
  const drop = $('drop-zone');
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (event) => { event.preventDefault(); drop.classList.remove('dragover'); addFiles([...event.dataTransfer.files]); });
  $('stop-all').addEventListener('click', () => { for (const id of [...active.keys()]) stopClip(id); });
  try {
    const library = await api('library');
    spotifyLinks = library.spotify;
    clips = library.clips.sort((a, b) => a.created - b.created);
    deck = library.deck;
    renderSpotify();
    renderDeck();
    renderClips();
    $('save-status').textContent = 'Loading saved sounds…';
    await migrateBrowserData();
    ready = true;
    $('save-status').textContent = 'Saved on this computer';
    showError('spotify-error', '');
    showError('deck-error', '');
    renderSpotify();
    renderDeck();
    renderClips();
  } catch (error) {
    $('save-status').textContent = `Storage unavailable: ${error.message}`;
    showError('deck-error', `Saved sounds could not load. Restart ./start.sh, then refresh this page. ${error.message}`);
    showError('spotify-error', 'Cannot add Spotify links until the local soundboard server is running. Start ./start.sh and refresh this page.');
    showError('file-error', error.message);
  }
}

init();
