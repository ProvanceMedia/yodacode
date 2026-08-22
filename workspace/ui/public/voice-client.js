// YodaCode voice client — wake word, speech-to-text, and speaking replies.
//
// Everything to do with audio happens here, in the browser. The server never
// receives a byte of audio: this listens, matches the wake word, transcribes
// locally via the Web Speech API, and sends a line of text over /ws/voice.
// Replies come back as text and are read aloud with speechSynthesis.
//
// The three things that actually make or break a hands-free client, none of
// which are about speech quality:
//
//   1. It must never hear itself. Recognition is suspended while speaking,
//      otherwise the assistant transcribes its own reply and answers it.
//   2. It must never quietly stop listening. Chrome ends recognition on its
//      own — after silence, after about a minute, on a transient network
//      error — so every end is treated as "restart", and the only thing that
//      stops it for good is you.
//   3. It must be obvious what state it's in. A microphone that died two
//      hours ago is worse than no microphone, so the orb, the title and the
//      connection dot all say the truth at a glance.
//
// Two microphone modes, because "always listening" is not for everyone:
//
//   wake    — recognition runs continuously and watches for the wake word.
//             Genuinely hands-free, and the only mode that works from across
//             the room. A wake word heard by mistake costs nothing on its own:
//             it opens a short window and dispatches only if you then speak.
//   hotkey  — recognition is NOT running. Nothing is captured or transcribed
//             until you press the key, and it stops again after one utterance.
//             Nothing can false-trigger because nothing is listening.
//
// The hotkey only reaches a web page while its tab is focused — a browser
// cannot claim a system-wide shortcut. A truly global key needs the extension
// or a native client.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const body = document.body;

  // ─── token ────────────────────────────────────────────────────────────────
  // Accept ?token=… once (so the page can be bookmarked or launched from a
  // script), then strip it from the URL and keep it in localStorage — a token
  // sitting in browser history is exactly what we avoided by not reusing the
  // dashboard password.
  const KEY_TOKEN = 'yoda.voice.token';
  const KEY_VOICE = 'yoda.voice.voiceURI';
  const KEY_MODE = 'yoda.voice.micMode';

  function resolveToken() {
    const url = new URL(location.href);
    const fromQuery = url.searchParams.get('token');
    if (fromQuery) {
      localStorage.setItem(KEY_TOKEN, fromQuery);
      url.searchParams.delete('token');
      history.replaceState({}, '', url.pathname + url.search + url.hash);
      return fromQuery;
    }
    const saved = localStorage.getItem(KEY_TOKEN);
    if (saved) return saved;
    const asked = prompt('Voice token (YODA_VOICE_TOKEN):');
    if (asked) localStorage.setItem(KEY_TOKEN, asked.trim());
    return asked ? asked.trim() : '';
  }

  let token = resolveToken();

  // ─── transcript panel ─────────────────────────────────────────────────────

  const MAX_ROWS = 40;

  function addRow(kind, who, what) {
    const empty = $('empty');
    if (empty) empty.closest('.row').remove();
    const row = document.createElement('div');
    row.className = `row ${kind}`;
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    const t = document.createElement('span');
    t.className = 'what';
    t.textContent = what;
    row.append(w, t);
    const log = $('log');
    log.append(row);
    while (log.children.length > MAX_ROWS) log.firstElementChild.remove();
    row.scrollIntoView({ block: 'nearest' });
  }

  // ─── state ────────────────────────────────────────────────────────────────

  const STATES = {
    offline:   { icon: '🔌', label: 'not connected' },
    idle:      { icon: '⌨️', label: 'microphone off — hold Space to talk' },
    listening: { icon: '🎙️', label: 'listening for the wake word' },
    awake:     { icon: '👂', label: 'go ahead…' },
    working:   { icon: '⚙️', label: 'working on it' },
    speaking:  { icon: '💬', label: 'speaking' },
    muted:     { icon: '🔇', label: 'muted' },
    error:     { icon: '⚠️', label: 'something is wrong' },
  };

  let state = 'offline';

  function setState(next, detail) {
    state = next;
    const s = STATES[next] || STATES.error;
    body.className = `s-${next}`;
    $('orb').textContent = s.icon;
    $('state').innerHTML = detail ? `<b>${escapeHtml(detail)}</b>` : s.label;
    // The tab title is the only thing visible when this is a background tab,
    // which is where it will spend most of its life.
    document.title = `${s.icon} Yoda Voice`;
    $('hush').classList.toggle('hidden', next !== 'speaking');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ─── connection ───────────────────────────────────────────────────────────

  let ws = null;
  let wsRetry = 0;
  let closedByUs = false;
  let wakeWords = ['hey yoda'];
  // A per-browser choice wins over the server's default: which machine this is
  // sitting on decides whether always-on listening is appropriate, not the
  // server. Resolved properly once 'ready' arrives.
  let micMode = localStorage.getItem(KEY_MODE) || 'wake';

  function setConn(ok, text) {
    $('dot').className = `dot ${ok ? 'ok' : 'bad'}`;
    $('connText').textContent = text;
  }

  function connect() {
    if (!token) { setConn(false, 'no token'); setState('error', 'no token'); return; }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/voice?token=${encodeURIComponent(token)}`;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      wsRetry = 0;
      setConn(true, 'connected');
      // In hotkey mode the microphone stays off until asked; applyMode() runs
      // on 'ready' and decides.
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServerMessage(msg);
    };

    ws.onclose = (ev) => {
      stopListening();
      if (ev.code === 4001) {
        // A bad token will never fix itself by retrying.
        setConn(false, 'rejected — bad token');
        setState('error', 'token rejected');
        localStorage.removeItem(KEY_TOKEN);
        token = '';
        addRow('sys', '·', 'The server rejected that token. Reload and enter a new one.');
        return;
      }
      if (ev.code === 4004) {
        setConn(false, 'voice surface off');
        setState('error', 'voice not enabled on the server');
        addRow('sys', '·', 'Add "voice" to YODA_SURFACES and restart yoda.');
        return;
      }
      if (closedByUs) return;
      setConn(false, 'reconnecting…');
      setState('offline');
      scheduleReconnect();
    };

    ws.onerror = () => { /* onclose always follows; handled there */ };
  }

  function scheduleReconnect() {
    // Backoff with jitter: a server restart shouldn't be met with a stampede,
    // but a laptop waking from sleep should be back within seconds.
    wsRetry = Math.min(wsRetry + 1, 6);
    const base = Math.min(1000 * 2 ** (wsRetry - 1), 30000);
    setTimeout(connect, base + Math.random() * 500);
  }

  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'ready':
        if (Array.isArray(msg.wakeWords)) {
          // Keep the fallback if nothing survives normalising — an operator who
          // configures a phrase this can't match should still have a working
          // wake word rather than a silently deaf page.
          const usable = msg.wakeWords.map(normalise).filter(Boolean);
          if (usable.length) wakeWords = usable;
          else addRow('sys', '·', 'Configured wake words are unusable here; keeping the default.');
        }
        if (!localStorage.getItem(KEY_MODE) && msg.micMode) micMode = msg.micMode;
        if (micFatal) {
          // The socket is fine; the microphone is not. Keep the true state
          // rather than painting over it with a green "listening".
          renderModeLabel();
          setState('error', micFatal);
        } else {
          applyMode();
        }
        break;
      case 'ack':
        // The echo of what was heard. No chime — you only just stopped talking.
        addRow('yoda', 'yoda', msg.text);
        speak(msg.text, { then: 'working' });
        break;
      case 'working':
        // A turn nobody spoke for — a background watch firing, a restart
        // recovery. Nothing to confirm, so show it and stay silent; the answer
        // will arrive with a chime of its own.
        setState('working');
        break;
      case 'speak':
        // The result, which may arrive minutes later while you're doing
        // something else entirely — hence the chime.
        addRow('yoda', 'yoda', msg.text + (msg.truncated ? ' …' : ''));
        chime();
        speak(msg.text, { then: 'listening' });
        break;
      case 'silent':
        addRow('sys', '·', '(nothing to say)');
        applyMode();
        break;
      case 'error':
        addRow('sys', '·', msg.text || 'error');
        applyMode();
        break;
      default:
        break;
    }
  }

  // ─── speech recognition ───────────────────────────────────────────────────

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  let recognising = false;     // the engine is actually running
  let wantListening = false;   // we intend to be listening
  let restartTimer = null;
  let awake = false;           // wake word heard, waiting for the command
  let awakeTimer = null;
  let muted = false;
  let recogFailures = 0;      // consecutive non-routine recognition errors
  let micFatal = null;        // set once the microphone cannot recover unattended

  const RECOG_FAILURES_BEFORE_NOTICE = 3;

  const AWAKE_WINDOW_MS = 8000;

  function normalise(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // How far into an utterance the wake word may start and still count. Speech
  // recognition often prepends a stray filler ("um", "so"), so a couple of words
  // of slack is realistic — but matching ANYWHERE would fire on "I was telling
  // Rob about hey yoda yesterday", which is exactly the accident worth avoiding.
  const WAKE_LEAD_WORDS = 2;

  /**
   * Find a wake word at the START of what was heard and return the rest.
   * "hey yoda check the sync" → { hit: true, rest: 'check the sync' }
   * A wake word buried mid-sentence does NOT count.
   */
  function matchWake(text) {
    const t = normalise(text);
    for (const w of wakeWords) {
      const i = t.indexOf(w);
      if (i === -1) continue;
      const lead = t.slice(0, i).trim();
      const leadWords = lead ? lead.split(' ').length : 0;
      if (leadWords > WAKE_LEAD_WORDS) continue; // said in passing, not to us
      return { hit: true, rest: t.slice(i + w.length).trim() };
    }
    return { hit: false, rest: '' };
  }

  function initRecognition() {
    if (!SR) {
      micFatal = 'this browser has no speech recognition';
      setState('error', micFatal);
      addRow('sys', '·', 'Speech recognition needs Chrome or Edge. Safari and Firefox will not work.');
      return false;
    }
    recog = new SR();
    recog.continuous = true;
    recog.interimResults = false;   // only settled text; interim is too noisy to match on
    recog.lang = navigator.language || 'en-GB';

    recog.onstart = () => {
      recognising = true;
      recogFailures = 0;   // it started, so whatever was wrong has cleared
      if (state === 'error' && !micFatal) applyMode();
    };

    recog.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res.isFinal) continue;
        onHeard((res[0] && res[0].transcript) || '');
      }
    };

    recog.onerror = (ev) => {
      // 'no-speech' and 'aborted' are routine — a quiet room, or our own
      // suspend while speaking. Reset the backoff on those.
      if (ev.error === 'no-speech' || ev.error === 'aborted') { recogFailures = 0; return; }

      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        wantListening = false;
        micFatal = 'microphone permission denied';
        setState('error', micFatal);
        addRow('sys', '·', 'Allow microphone access for this site, then reload.');
        return;
      }

      // Anything else — 'audio-capture' (mic unplugged, or another app holding
      // it), 'network' — can persist. Restarting three times a second behind a
      // green light for the rest of the day is the worst possible response.
      recogFailures++;
      if (recogFailures === RECOG_FAILURES_BEFORE_NOTICE) {
        addRow('sys', '·', `Microphone trouble (${ev.error}). Still retrying, more slowly.`);
        setState('error', `microphone: ${ev.error}`);
      }
    };

    recog.onend = () => {
      recognising = false;
      // Chrome ends recognition constantly and without ceremony. If we still
      // intend to listen, start again — this loop IS the always-on microphone.
      if (wantListening) {
        clearTimeout(restartTimer);
        // Backs off once errors start repeating, so an unplugged microphone
        // costs one retry every few seconds rather than three every second.
        const delay = recogFailures > 0
          ? Math.min(1000 * 2 ** Math.min(recogFailures, 5), 30000)
          : 350;
        restartTimer = setTimeout(startRecognition, delay);
      }
    };
    return true;
  }

  function startRecognition() {
    if (!recog || recognising || !wantListening) return;
    try {
      recog.start();
    } catch (e) {
      // start() throws if the engine hasn't finished stopping; try again shortly.
      clearTimeout(restartTimer);
      restartTimer = setTimeout(startRecognition, 400);
    }
  }

  function startListening() {
    if (!recog && !initRecognition()) return;
    wantListening = true;
    startRecognition();
    if (state !== 'working' && state !== 'speaking') setState('listening');
  }

  /**
   * Put the microphone into whatever the current mode says it should be.
   * In wake mode that means running; in hotkey mode it means off until asked.
   * Called on connect, on a mode change, and after every turn ends.
   */
  /** Label only — safe to call before the socket is up, when the microphone
   *  must stay off regardless of mode. */
  function renderModeLabel() {
    $('mode').textContent = micMode === 'hotkey' ? 'Push to talk' : 'Wake word';
    $('mode').title = micMode === 'hotkey'
      ? 'The microphone is off until you press Space. Click to listen for the wake word instead.'
      : 'Listening for the wake word. Click to switch the microphone off until you press Space.';
    updateHint();
  }

  function applyMode() {
    renderModeLabel();
    if (muted) { stopListening(); setState('muted'); return; }
    // Mid-sentence: leave the microphone suspended. The utterance's own done()
    // calls applyMode() again when it finishes, which is the right moment.
    if (state === 'speaking' && speechSynthesis.speaking) return;
    if (micMode === 'wake') {
      startListening();
      setState('listening');
    } else {
      // Genuinely off: not transcribing, so nothing can trigger it.
      stopListening();
      awake = false;
      clearTimeout(awakeTimer);
      setState('idle');
    }
  }

  function updateHint() {
    $('hint').innerHTML = micMode === 'hotkey'
      ? 'The microphone is <b>off</b>. Hold <kbd>Space</kbd> and speak. '
        + '<kbd>M</kbd> mutes, <kbd>Esc</kbd> stops the current run.'
      : `Say <b>“${escapeHtml(wakeWords[0])}”</b> to start. `
        + '<kbd>Space</kbd> talks without a wake word, <kbd>M</kbd> mutes, '
        + '<kbd>Esc</kbd> stops the current run.';
  }

  /**
   * Open a window for one instruction: start the microphone if the mode keeps
   * it off, and take the next thing said. Used by the hotkey and by a bare wake
   * word. Closes itself if nothing is said.
   */
  function armForOneUtterance() {
    if (muted) return;
    awake = true;
    startListening();
    setState('awake');
    blip();
    clearTimeout(awakeTimer);
    awakeTimer = setTimeout(() => {
      awake = false;
      // Only reclaim the display if we're still the ones holding it. A reply
      // that started arriving during the window owns the state now, and pulling
      // it out from under that hides the Stop-speaking button mid-sentence.
      if (state === 'awake') applyMode();
    }, AWAKE_WINDOW_MS);
  }

  function stopListening() {
    wantListening = false;
    clearTimeout(restartTimer);
    // Unconditionally, not only when `recognising`: that flag is set at onstart,
    // so between start() and onstart it reads false while the engine is very
    // much live. Skipping stop() there leaves the microphone on for the whole
    // reply — the feedback loop, arriving through the back door. abort() is the
    // harder of the two and won't emit a trailing result.
    if (recog) { try { recog.abort(); } catch (_) { /* not started yet */ } }
  }

  function onHeard(raw) {
    const heard = raw.trim();
    if (!heard) return;

    if (awake) {
      clearTimeout(awakeTimer);
      awake = false;
      dispatch(heard);
      return;
    }

    // In hotkey mode nothing below applies: the wake word is not a trigger,
    // only the key is. (Recognition should not even be running here, but a
    // late result can still arrive from the engine as it winds down.)
    if (micMode === 'hotkey') return;

    const { hit, rest } = matchWake(heard);
    if (!hit) return;

    if (rest.split(' ').filter(Boolean).length >= 2) {
      // "Hey Yoda, check the sync" — one breath, one instruction. The common case.
      dispatch(rest);
      return;
    }

    // Just the wake word: open a window rather than acting. A wake word heard
    // by mistake dies here, having cost nothing.
    armForOneUtterance();
  }

  function dispatch(text) {
    addRow('you', 'you', text);
    if (!send({ type: 'utterance', text })) {
      // Not connected. Saying nothing here is the worst outcome: you spoke, the
      // transcript showed it, and nothing ever happened.
      addRow('sys', '·', 'Not connected — that did not get through. Try again in a moment.');
      blip();
      applyMode();
      return;
    }
    setState('working');
    // In hotkey mode the window is over: the microphone goes back off until the
    // key is pressed again. In wake mode this is a no-op beyond the state.
    if (micMode === 'hotkey') stopListening();
  }

  // ─── speaking ─────────────────────────────────────────────────────────────

  let voices = [];
  let chosenVoice = null;
  let keepAlive = null;
  let speechWatchdog = null;
  // Bumped for every utterance. cancel() fires onend on the utterance it just
  // killed, so without this the cancelled one's handler runs and reopens the
  // microphone while its replacement is mid-sentence.
  let speechGen = 0;

  function loadVoices() {
    voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const sel = $('voices');
    sel.innerHTML = '';
    const saved = localStorage.getItem(KEY_VOICE);
    voices.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = `${v.name}${v.default ? ' (default)' : ''}`;
      sel.append(o);
      if (v.voiceURI === saved) sel.selectedIndex = i;
    });
    chosenVoice = voices.find((v) => v.voiceURI === saved)
      || voices.find((v) => v.default)
      || voices[0] || null;
    if (chosenVoice) sel.value = chosenVoice.voiceURI;
  }

  function speak(text, { then = 'listening' } = {}) {
    if (muted || !window.speechSynthesis || !text) { setState(muted ? 'muted' : then); return; }

    // Suspend the microphone for the duration. Without this it transcribes its
    // own voice and answers itself — the single most important line here.
    stopListening();
    setState('speaking');

    const u = new SpeechSynthesisUtterance(text);
    if (chosenVoice) u.voice = chosenVoice;
    u.rate = 1.0;
    u.pitch = 1.0;

    const gen = ++speechGen;
    let finished = false;
    const done = () => {
      if (finished || gen !== speechGen) return; // superseded by a newer utterance
      finished = true;
      clearInterval(keepAlive);
      clearTimeout(speechWatchdog);
      if (muted) { setState('muted'); return; }
      // 'working' means the turn is still running, so hold that state and leave
      // the microphone as it was. Otherwise the turn is over: hand the
      // microphone back to whatever the mode says it should be.
      if (then === 'working') { setState('working'); if (micMode === 'wake') startListening(); }
      else applyMode();
    };
    u.onend = done;
    u.onerror = done;

    // Chrome sometimes drops an utterance without ever firing onend or onerror.
    // The microphone is suspended until one of them does, so without a ceiling
    // that becomes an assistant that stopped listening and never said so —
    // the exact failure this client exists to avoid. Budget generously from the
    // length (roughly 12 characters a second) so it never cuts real speech off.
    clearTimeout(speechWatchdog);
    speechWatchdog = setTimeout(done, 8000 + text.length * 90);

    speechSynthesis.cancel();
    speechSynthesis.speak(u);

    // Chrome stops synthesising after roughly fifteen seconds unless nudged.
    // A reply that cuts off mid-sentence reads as a crash, so keep it awake.
    clearInterval(keepAlive);
    keepAlive = setInterval(() => {
      if (!speechSynthesis.speaking) { clearInterval(keepAlive); return; }
      speechSynthesis.pause();
      speechSynthesis.resume();
    }, 12000);
  }

  function hush() {
    if (!window.speechSynthesis) return;
    clearInterval(keepAlive);
    clearTimeout(speechWatchdog);
    speechSynthesis.cancel();
    applyMode();
  }

  // ─── sounds ───────────────────────────────────────────────────────────────
  // Two short tones, synthesised rather than fetched so the page stays
  // self-contained. The chime matters: a reply can arrive long after you asked,
  // and speech starting out of nowhere in a quiet room is startling.

  let audioCtx = null;

  function tone(freq, when, dur, gain) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const amp = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      amp.gain.setValueAtTime(0, audioCtx.currentTime + when);
      amp.gain.linearRampToValueAtTime(gain, audioCtx.currentTime + when + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + when + dur);
      osc.connect(amp).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + when);
      osc.stop(audioCtx.currentTime + when + dur + 0.02);
    } catch (_) { /* no audio context before a user gesture — silence is fine */ }
  }

  const blip  = () => tone(880, 0, 0.09, 0.05);
  const chime = () => { tone(660, 0, 0.11, 0.05); tone(880, 0.1, 0.16, 0.05); };

  // ─── controls ─────────────────────────────────────────────────────────────

  function setMuted(next) {
    muted = next;
    $('mute').textContent = muted ? 'Unmute' : 'Mute';
    $('mute').classList.toggle('on', muted);
    if (muted) { hushSilently(); stopListening(); setState('muted'); return; }
    applyMode();
  }

  function hushSilently() {
    clearInterval(keepAlive);
    clearTimeout(speechWatchdog);
    if (window.speechSynthesis) speechSynthesis.cancel();
  }

  $('mode').onclick = () => {
    micMode = micMode === 'wake' ? 'hotkey' : 'wake';
    localStorage.setItem(KEY_MODE, micMode);
    applyMode();
  };

  $('mute').onclick = () => setMuted(!muted);
  $('orb').onclick = () => setMuted(!muted);
  $('hush').onclick = hush;

  $('voices').onchange = (e) => {
    chosenVoice = voices.find((v) => v.voiceURI === e.target.value) || null;
    if (chosenVoice) {
      localStorage.setItem(KEY_VOICE, chosenVoice.voiceURI);
      speak('This is how I will sound.', { then: muted ? 'muted' : 'listening' });
    }
  };

  $('forget').onclick = () => {
    localStorage.removeItem(KEY_TOKEN);
    closedByUs = true;
    if (ws) ws.close();
    location.reload();
  };

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') {
      // The activation key. In wake mode it skips the wake word; in hotkey mode
      // it is the only thing that turns the microphone on at all.
      e.preventDefault();
      if (e.repeat) return;
      armForOneUtterance();
    } else if (e.key === 'm' || e.key === 'M') {
      setMuted(!muted);
    } else if (e.key === 'Escape') {
      // Reaches the same stop handler a typed "stop" does — provided the voice
      // user id is in YODA_STOP_AUTHORIZED_USERS.
      hush();
      send({ type: 'utterance', text: 'stop' });
      addRow('you', 'you', 'stop');
    }
  });

  // ─── boot ─────────────────────────────────────────────────────────────────

  if (window.speechSynthesis) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }

  // Browsers refuse audio until the page has been interacted with once; this
  // unlocks the context so the first chime isn't silently swallowed.
  document.addEventListener('click', function unlock() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) { /* nothing to unlock */ }
    document.removeEventListener('click', unlock);
  });

  window.addEventListener('beforeunload', () => { closedByUs = true; stopListening(); });

  // Label the mode from the saved preference before connecting — the button
  // must not claim "Wake word" while the browser is actually set to push to
  // talk. The microphone itself stays off until 'ready' calls applyMode().
  renderModeLabel();
  setState('offline');
  setConn(false, 'connecting…');
  connect();
})();
