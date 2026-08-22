# Voice — talking to your assistant hands-free

Say a wake word, give an instruction the way you'd type it, and hear the answer
when it's done.

```
you    "hey yoda, check whether the hubspot sync finished"
yoda   "Got it: check whether the hubspot sync finished"      ← straight away
       …quiet while it works…
yoda   "Sync finished about forty minutes ago, no errors"     ← when it's done
```

It's deliberately half-duplex: it listens, confirms, goes quiet, then speaks
once. It does not narrate the tools it uses. That's useful on a screen and
intolerable in a room.

## What it costs

Nothing. The microphone never leaves your browser — the page listens, matches
the wake word, transcribes locally through the Web Speech API and reads replies
with the system voice. Only text crosses the wire. There is no speech vendor,
no API key and no meter.

## Setup

### 1. Configure it

```bash
# .env
YODA_SURFACES=slack,voice
YODA_VOICE_TOKEN=$(openssl rand -hex 24)   # paste the value, not the command
YODA_VOICE_USER_ID=voice-owner
YODA_VOICE_WAKE_WORDS=hey yoda,hello yoda,ok yoda

# Say "stop" out loud and have it actually stop:
YODA_STOP_AUTHORIZED_USERS=U01234ABCDE,voice-owner

# The dashboard is now reachable. Set a password.
YODA_UI_PASS=something-long
```

Apply it with **`yodacode restart`**. Not `docker compose restart` — that reuses
each container's existing config and never re-reads `.env`, so your changes
appear to do nothing at all.

### 2. Reach it over HTTPS or localhost

**A browser will not grant microphone access over plain HTTP.** There is no
override, no flag, no prompt — `getUserMedia` simply fails. `compose.yaml`
publishes the dashboard on `127.0.0.1` only, so pick one of these:

**Tailscale (recommended).** Already the project's suggested way to reach the
dashboard, and it hands you a real certificate:

```bash
tailscale serve --bg 7890
# → https://your-host.your-tailnet.ts.net
```

No port forwarding, nothing public, and the HTTPS requirement is satisfied.

**SSH tunnel.** Good for trying it this afternoon:

```bash
ssh -L 7890:localhost:7890 your-server
# → http://localhost:7890   (localhost is exempt from the HTTPS rule)
```

Fine for a test, poor for always-on: when the tunnel drops the microphone goes
quiet and nothing tells you.

**A public port behind a reverse proxy.** Works, but puts the dashboard on the
internet behind nothing but `YODA_UI_PASS`. Given the broker and the de-rooting
elsewhere in this project, that would be the weakest thing in it. Don't.

> **Set `YODA_UI_PASS`.** Publishing the port is what makes the dashboard
> reachable at all, and with the password empty it has no authentication —
> anyone who can reach the port can read your memory files and rewrite
> `CLAUDE.md`. Cross-site requests and foreign-origin WebSocket upgrades are
> refused regardless, so a website you visit can't reach it, but that is a
> backstop and not a substitute for the password. If a proxy rewrites the
> `Host` header so the page's origin differs from what it connects to, list the
> real origin in `YODA_UI_ALLOWED_ORIGINS`.

### 3. Open it

Go to `/voice.html`, enter the token when asked, and allow the microphone.
Chrome or Edge — Safari and Firefox have no usable speech recognition.

**The tab has to stay open.** It *is* the microphone: it does the listening, the
transcribing and the speaking. Close it and voice stops until you open it again.
Pin it, or use a separate window you leave alone.

**On a phone?** Chrome on Android works. iOS does not — every browser there is
Safari underneath, and Safari has no usable speech recognition, so the page
loads and the microphone never does anything useful.

You can also launch it with `?token=…` in the URL. The page saves the token and
strips it from the address bar so it doesn't sit in your history.

## Two microphone modes

Always-on listening isn't for everyone, so there are two modes. The button on
the page switches between them per-browser; `YODA_VOICE_MIC_MODE` sets the
default a new browser starts from.

**Wake word** (default) — recognition runs continuously and watches for the
wake word. Properly hands-free, and the only mode that works from across the
room.

**Push to talk** — recognition is **not running**. Nothing is captured or
transcribed until you press <kbd>Space</kbd>, and it switches off again after
one instruction. Nothing can false-trigger because nothing is listening.

The catch with push to talk: a web page only receives keys while its tab is
focused. A browser cannot claim a system-wide shortcut, so you have to be on
the voice tab to press the key. A genuinely global hotkey needs a browser
extension or a native client.

### How likely is a false trigger, really?

Three things make one cheap in wake mode:

1. **The wake word only counts at the start of what you say.** Up to two words
   of lead-in are allowed, because recognition often prepends a filler — but
   "I was telling Rob about hey yoda yesterday" is ignored.
2. **A bare wake word does nothing.** It opens an eight-second window and blips.
   Say nothing and it closes, having dispatched nothing.
3. **You always hear what it thought you said** before it acts, because the
   confirmation is a verbatim echo. If it mishears, say "stop".

The case that does dispatch immediately is a wake word followed by two or more
words in the same breath — the common "hey yoda, check the sync". If that fires
by accident, the echo tells you and <kbd>Esc</kbd> stops it.

If none of that reassures you, use push to talk. It removes the question
entirely: the microphone genuinely isn't on.

## Using it

| | |
|---|---|
| **"hey yoda, do the thing"** | one breath, one instruction — the usual case |
| **"hey yoda"** … *"do the thing"* | wake, then talk within eight seconds |
| **Space** | in wake mode, skip the wake word; in push-to-talk, turn the mic on for one instruction |
| **M** | mute — stops listening *and* speaking |
| **Esc** | stop the current run and stop speaking |
| **click the orb** | mute / unmute |
| **the mode button** | switch between wake word and push to talk |

The orb and the tab title always show the true state: microphone off,
listening, awake, working, speaking, muted, offline.

## What to expect

**It sounds like a voice assistant, not a person.** System voices are decent on
macOS, dated on Windows and poor on Linux. Pick one from the dropdown. If it
grates, swap in a neural voice later — that's one function in
`ui/public/voice-client.js`, and for the volume involved a paid one costs a few
pounds a month.

**Replies are written for the ear.** The surface tells the agent to drop
markdown, URLs and code, keep it to a few sentences, and lead with the answer.
Anything that slips through is stripped on the way out — a synthesiser will
otherwise happily pronounce backticks.

**Long answers get trimmed** at `YODA_VOICE_MAX_SPEAK_CHARS` (700 by default),
cut at a sentence boundary.

**"I'll tell you when it's done" actually works.** If a turn arms a background
watch, the answer arrives minutes later, spoken, with a chime first — you don't
have to be at the machine.

**Voice is its own conversation.** It gets its own lane and its own session, so
a follow-up in Slack won't know what you said out loud. Memory is shared, so
anything durable crosses over normally.

## When something's wrong

| symptom | cause |
|---|---|
| No microphone prompt | Not on HTTPS or localhost. See step 2. |
| "token rejected" | `YODA_VOICE_TOKEN` doesn't match. Click **Sign out** and re-enter. |
| "voice not enabled on the server" | `voice` is missing from `YODA_SURFACES`. |
| Nothing happens on the wake word | Check the tab is unmuted and the dot is green. Try **Space** to bypass the wake word. |
| It answers itself | Shouldn't happen — recognition is suspended while speaking. If it does, the reply is being played through a speaker the mic hears *and* something is restarting recognition early; file it. |
| Says "stop" but keeps going | Add `YODA_VOICE_USER_ID`'s value to `YODA_STOP_AUTHORIZED_USERS`. |

## How it fits together

```
browser                          yoda
─────────                        ────────────────────────────────
wake word  ┐
capture    ├─ all local          ui/server.js   /ws/voice
transcribe ┘                            │
           └── {"utterance"} ──────────►│
                                        ▼
                                 lib/voice-bus.js
                                        │
                                        ▼
                                 lib/surfaces/voice.js
                                        │
                                        ▼
                                 lib/dispatcher.js  ← the same path Slack uses
                                        │
           ◄── {"ack"} / {"speak"} ──────┘
speak
```

From the dispatcher onwards a spoken turn is indistinguishable from a typed
one: same queue, same session resume, same stop handler, same background
watches. `lib/surfaces/slack.js` is not touched, and removing `voice` from
`YODA_SURFACES` puts everything back exactly as it was.
