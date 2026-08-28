// ─── Quiet hours ──────────────────────────────────────────────────────────────
// Dailies reset at 00:00 UTC — 05:30 in IST — so the daily reminder lands in the
// middle of the night. Rather than dropping those pings, hold them and deliver
// one summary when the window ends, so nothing is actually missed.
//
//   nh quiet 23:00-08:00   set a window (times are IST unless a tz is given)
//   nh quiet 23:00-08:00 +00:00
//   nh quiet off           clear it
//   nh quiet               show the current window

const { trace } = require('./debug');

// The user base is in India; default the window to IST rather than UTC.
const DEFAULT_TZ_MINUTES = 330; // +05:30

// userId → { startMin, endMin, tz }
const configs = new Map();

// userId → Map<command, { channel, at }> waiting for the window to end
const deferred = new Map();

// userId → timeout handle for the flush
const flushTimers = new Map();

const pad = (n) => String(n).padStart(2, '0');
const asClock = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

const parseWindow = (raw) => {
  const m = String(raw ?? '').trim()
    .match(/^(\d{1,2}):(\d{2})\s*(?:-|–|to)\s*(\d{1,2}):(\d{2})(?:\s*([+-]\d{1,2}):?(\d{2})?)?$/i);
  if (!m) return null;

  const startMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const endMin   = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  if (startMin > 1439 || endMin > 1439) return null;
  if (startMin === endMin) return null; // a zero-length or all-day window is never what's meant

  let tz = DEFAULT_TZ_MINUTES;
  if (m[5]) {
    const sign = m[5].startsWith('-') ? -1 : 1;
    tz = sign * (Math.abs(parseInt(m[5], 10)) * 60 + parseInt(m[6] ?? '0', 10));
  }
  return { startMin, endMin, tz };
};

// Minutes past midnight in the config's timezone.
const localMinutes = (cfg, at = Date.now()) => {
  const shifted = new Date(at + cfg.tz * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const isQuiet = (userId, at = Date.now()) => {
  const cfg = configs.get(userId);
  if (!cfg) return false;
  const now = localMinutes(cfg, at);
  // A window crossing midnight (23:00-08:00) is "outside" rather than "between".
  return cfg.startMin < cfg.endMin
    ? now >= cfg.startMin && now < cfg.endMin
    : now >= cfg.startMin || now < cfg.endMin;
};

/** When the current quiet window ends, as an epoch ms value. */
const windowEnd = (userId, at = Date.now()) => {
  const cfg = configs.get(userId);
  if (!cfg) return null;
  const now = localMinutes(cfg, at);
  let delta = cfg.endMin - now;
  if (delta <= 0) delta += 1440;
  return at + delta * 60_000;
};

const getConfig = (userId) => configs.get(userId) ?? null;

const describe = (userId) => {
  const cfg = configs.get(userId);
  if (!cfg) return null;
  const sign = cfg.tz < 0 ? '-' : '+';
  const tzTxt = `${sign}${pad(Math.floor(Math.abs(cfg.tz) / 60))}:${pad(Math.abs(cfg.tz) % 60)}`;
  return `${asClock(cfg.startMin)}–${asClock(cfg.endMin)} (UTC${tzTxt})`;
};

const setConfig = (userId, cfg) => {
  if (cfg) configs.set(userId, cfg);
  else {
    configs.delete(userId);
    const t = flushTimers.get(userId);
    if (t) { clearTimeout(t); flushTimers.delete(userId); }
  }
};

const loadAll = (rows) => {
  for (const { userId, quiet } of rows) {
    if (quiet?.startMin != null && quiet?.endMin != null) {
      configs.set(userId, { startMin: quiet.startMin, endMin: quiet.endMin, tz: quiet.tz ?? DEFAULT_TZ_MINUTES });
    }
  }
  return configs.size;
};

/**
 * Hold a reminder until the window ends. Returns true if it was deferred, false
 * if it should be delivered now.
 */
const deferReminder = (userId, command, channel) => {
  if (!isQuiet(userId)) return false;

  const queue = deferred.get(userId) ?? new Map();
  queue.set(command, { channel, at: Date.now() }); // one entry per command
  deferred.set(userId, queue);

  if (!flushTimers.has(userId)) {
    const delay = Math.max(1000, windowEnd(userId) - Date.now());
    const timer = setTimeout(() => flush(userId), delay);
    timer.unref();
    flushTimers.set(userId, timer);
    trace('quiet: deferring', { userId, command, flushInMinutes: Math.round(delay / 60000) });
  }
  return true;
};

/** Deliver everything held for a user as one message. */
const flush = async (userId) => {
  flushTimers.delete(userId);
  const queue = deferred.get(userId);
  deferred.delete(userId);
  if (!queue?.size) return;

  // Any channel will do — they are all the same channel in practice.
  const channel = [...queue.values()][0].channel;
  const items = [...queue.entries()]
    .sort(([, a], [, b]) => a.at - b.at)
    .map(([cmd, v]) => `> **${cmd}** — ready since <t:${Math.floor(v.at / 1000)}:t>`);

  const text =
    `<@${userId}> 🌅 good morning — while reminders were quiet:\n${items.join('\n')}`;

  try {
    await channel.send(text);
  } catch (err) {
    console.error(`[quiet] flush failed for ${userId}: ${err.message}`);
  }
};

const pendingCount = (userId) => deferred.get(userId)?.size ?? 0;

module.exports = {
  parseWindow, isQuiet, windowEnd, getConfig, setConfig, describe,
  deferReminder, flush, loadAll, pendingCount, DEFAULT_TZ_MINUTES,
};
