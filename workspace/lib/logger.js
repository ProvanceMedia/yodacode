// Tiny structured logger. JSON lines to stdout/stderr so systemd captures cleanly.
// Levels: debug, info, warn, error.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.YODA_LOG_LEVEL || 'info'] ?? LEVELS.info;

function log(level, msg, fields = {}) {
  if (LEVELS[level] < MIN) return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg, fields) => log('debug', msg, fields),
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
};
