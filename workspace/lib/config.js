// Centralised env-driven config. Single source of truth for all runtime knobs.
// All values are read from process.env, with sane defaults where possible.
// Secrets are required and the process exits if any are missing.

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: required env var ${name} is not set`);
    process.exit(2);
  }
  return v;
}

function csv(name, fallback = '') {
  return (process.env[name] || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  // Which surfaces are enabled. CSV of names from lib/surfaces/*.
  // The yoda.js coordinator dynamically imports each enabled surface.
  surfaces: csv('YODA_SURFACES', 'slack'),

  // Slack auth — both bot and app tokens needed for Socket Mode.
  // Loaded lazily by the surface so the process doesn't crash if Slack is
  // not enabled in YODA_SURFACES.
  slack: {
    get botToken() { return required('SLACK_BOT_TOKEN'); },
    get appToken() { return required('SLACK_APP_TOKEN'); },
  },

  // WhatsApp (Baileys) config — only required if 'whatsapp' is in YODA_SURFACES.
  whatsapp: {
    // Authorised phone numbers in international format with no '+' or spaces
    // (e.g. 44XXXXXXXXXX). DMs from anyone else are silently ignored.
    authorizedUsers: new Set(csv('YODA_WHATSAPP_AUTHORIZED', '')),
    // Group JIDs that Yoda is allowed to participate in. Default empty = ignore all groups.
    allowedGroups: new Set(csv('YODA_WHATSAPP_GROUPS', '')),
    // Where Baileys stores its multi-file auth state across restarts
    authDir: process.env.YODA_WHATSAPP_AUTH_DIR || './state/whatsapp-auth',
    // Phone number used for pairing-code-based pairing (preferred over QR for
    // headless servers). International format, no '+'.
    pairingPhone: process.env.YODA_WHATSAPP_PAIRING_PHONE || '',
    // Slack channel ID to upload the QR PNG to during pairing. Lets you scan
    // from your phone using Slack as the display surface. Optional.
    qrSlackChannel: process.env.YODA_WHATSAPP_QR_SLACK_CHANNEL || '',
  },

  // Bot identity (the user id of the bot itself, used to ignore self-messages
  // and detect mentions). Discoverable at startup via auth.test if not set.
  botUserId: process.env.BOT_USER_ID || null,

  // Reply policy — env-driven so the rules are portable for the open-source template.
  // CSV of user ids whose DMs Yoda always replies to (in addition to anyone if YODA_DM_OPEN=1).
  // CSV of channel ids where Yoda replies on @-mention.
  // RESTRICTED_CHANNELS is "<channelId>:<userId>" pairs — only respond when that user mentions
  // the bot in that specific channel.
  policy: {
    dmAuthorizedUsers: new Set(csv('YODA_DM_AUTHORIZED_USERS', '')),
    dmOpen: process.env.YODA_DM_OPEN === '1',
    mentionChannels: new Set(csv('YODA_MENTION_CHANNELS', '')),
    restrictedChannels: parseRestricted(csv('YODA_RESTRICTED_CHANNELS', '')),
  },

  // Stop word config
  stop: {
    pattern: process.env.YODA_STOP_PATTERN ||
      '^\\s*(stop|halt|abort|cancel|kill|stfu|shut\\s*up)\\s*[!.?]*\\s*$',
    authorizedUsers: new Set(csv('YODA_STOP_AUTHORIZED_USERS', '')),
  },

  // Claude runner
  claude: {
    bin: process.env.CLAUDE_BIN || 'claude',
    allowedTools: process.env.YODA_ALLOWED_TOOLS ||
      'Bash,Read,Write,Edit,WebFetch,Glob,Grep,Task',
    permissionMode: process.env.YODA_PERMISSION_MODE || 'acceptEdits',
    // Hard timeout per claude invocation (ms). Default 10 min — long enough
    // for legitimate multi-step enrichment / prospecting work that may
    // involve several curls + a browser-tools.sh verification.
    timeoutMs: parseInt(process.env.YODA_CLAUDE_TIMEOUT_MS || '600000', 10),
    // Bail out after N consecutive Anthropic api_retry events. Claude defaults
    // to 10 retries with exponential backoff, which can hang for 60+ seconds
    // on a sustained 529. Failing fast at ~3 retries (≈8s total) is a much
    // better UX and avoids deepening the cooldown by sustaining load.
    maxRetries: parseInt(process.env.YODA_CLAUDE_MAX_RETRIES || '3', 10),
    // Primary model (empty string = let Claude Code use its built-in default)
    model: process.env.YODA_CLAUDE_MODEL || '',
    // CSV of fallback models tried in order if the primary returns a
    // throttled (529-style) failure. Empty = no fallback.
    fallbackModels: csv('YODA_CLAUDE_FALLBACK_MODELS', 'claude-haiku-4-5'),
    // Tool-loop guardrails. Apply only to surface ticks (Slack/WhatsApp) that
    // go through runClaude. Crons spawn `claude -p` directly and are bounded
    // by their own timeouts.
    maxIterations: parseInt(process.env.YODA_MAX_ITERATIONS_SLACK || '60', 10),
    guardrailEnabled: process.env.YODA_GUARDRAIL_ENABLED !== '0',
    guardrailRepeatThreshold: parseInt(process.env.YODA_GUARDRAIL_REPEAT_THRESHOLD || '2', 10),
    guardrailNoProgressThreshold: parseInt(process.env.YODA_GUARDRAIL_NOPROGRESS_THRESHOLD || '3', 10),
  },

  // Skill self-generation. After a successful surface tick that crosses the
  // duration/tool-count threshold, dispatcher spawns a background `claude -p`
  // that decides whether to write a new skills/<slug>.md. Default OFF —
  // opt-in via YODA_SKILL_REFLECTOR_ENABLED=1.
  skills: {
    reflectorEnabled: process.env.YODA_SKILL_REFLECTOR_ENABLED === '1',
    minDurationMs: parseInt(process.env.YODA_SKILL_MIN_DURATION_MS || '30000', 10),
    minToolCount: parseInt(process.env.YODA_SKILL_MIN_TOOL_COUNT || '5', 10),
    reflectorModel: process.env.YODA_SKILL_REFLECTOR_MODEL || 'claude-haiku-4-5',
    reflectorTimeoutMs: parseInt(process.env.YODA_SKILL_REFLECTOR_TIMEOUT_MS || '120000', 10),
  },

  // Memory self-generation. Mirror of the skill reflector but for durable
  // FACTS (user-fact, feedback, project-state, reference) rather than
  // reusable procedures. Default OFF — opt in via
  // YODA_MEMORY_REFLECTOR_ENABLED=1.
  memory: {
    reflectorEnabled: process.env.YODA_MEMORY_REFLECTOR_ENABLED === '1',
    minDurationMs: parseInt(process.env.YODA_MEMORY_MIN_DURATION_MS || '30000', 10),
    minToolCount: parseInt(process.env.YODA_MEMORY_MIN_TOOL_COUNT || '5', 10),
    reflectorModel: process.env.YODA_MEMORY_REFLECTOR_MODEL || 'claude-haiku-4-5',
    reflectorTimeoutMs: parseInt(process.env.YODA_MEMORY_REFLECTOR_TIMEOUT_MS || '120000', 10),
  },

  // Conversation context window
  context: {
    threadFetchLimit: parseInt(process.env.YODA_THREAD_LIMIT || '50', 10),
    channelFetchLimit: parseInt(process.env.YODA_CHANNEL_LIMIT || '15', 10),
  },

  // Sandbox — uses Claude Code's built-in bubblewrap/Seatbelt sandbox.
  // When enabled, bash commands run with filesystem + network isolation.
  sandbox: {
    // 'off' = no sandbox (default — lets the agent install systemd units,
    //   sudo, talk to D-Bus, etc. end-to-end without manual handoffs).
    // 'auto' = bubblewrap sandbox + auto-allow (restricts filesystem +
    //   network; blocks systemctl/D-Bus/sudo so multi-step ops fail).
    // 'prompt' = sandbox + prompt on each violation.
    mode: process.env.YODA_SANDBOX || 'off',
    // CSV of domains the agent is allowed to reach when sandboxed.
    // Add your API domains here when adding new integrations.
    allowedDomains: csv('YODA_SANDBOX_ALLOWED_DOMAINS', ''),
  },

  // Misc
  workspace: process.env.YODA_WORKSPACE || process.cwd(),
  stateDir: process.env.YODA_STATE_DIR || './state',
};

function parseRestricted(pairs) {
  const out = new Map();
  for (const p of pairs) {
    const [channel, user] = p.split(':');
    if (channel && user) out.set(channel, user);
  }
  return out;
}
