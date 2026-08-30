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

const pad = (n) => String(n).padStart(2, '0');
const asClock = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// Most of this server plays from India, so an unqualified window is read as IST
// rather than UTC — a sensible default is better than a wrong-for-everyone one.
// It is only a default: `nh tz` sets your own, and every window is echoed back
// with the zone it was understood in, so nobody has to guess.
const DEFAULT_TZ_MINUTES = 330; // +05:30

// ─── Timezones ────────────────────────────────────────────────────────────────
// A window can be anchored two ways:
//
//   a number   fixed offset in minutes, e.g. 330 for +05:30
//   a string   IANA zone, e.g. "Europe/Berlin"
//
// Prefer the zone name. A fixed offset is wrong for half the year anywhere that
// observes DST: someone in Berlin who sets +02:00 in August finds their quiet
// hours an hour out come October, and the reminder they muted arrives while they
// are asleep. A zone name is resolved against the actual instant, so it follows
// the changeover by itself.
const zoneOffsetCache = new Map();  // `${zone}|${hourBucket}` → minutes

const offsetForZone = (zone, at) => {
  const bucket = Math.floor(at / 3_600_000);          // DST shifts on hour lines
  const key    = `${zone}|${bucket}`;
  const hit    = zoneOffsetCache.get(key);
  if (hit !== undefined) return hit;

  let minutes = DEFAULT_TZ_MINUTES;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(at))
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      minutes = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] ?? '0', 10));
    } else if (/^GMT$/.test(name)) {
      minutes = 0;                                     // GMT prints bare at +00:00
    }
  } catch {
    // Unknown zone — fall through to the default rather than throwing inside a
    // reminder path. Validation happens when it is set, not when it is read.
  }
  if (zoneOffsetCache.size > 500) zoneOffsetCache.clear();
  zoneOffsetCache.set(key, minutes);
  return minutes;
};

/** Offset in minutes for whatever `tz` holds, at a given instant. */
const resolveOffset = (tz, at = Date.now()) => {
  if (typeof tz === 'number' && Number.isFinite(tz)) return tz;
  if (typeof tz === 'string' && tz.trim()) return offsetForZone(tz.trim(), at);
  return DEFAULT_TZ_MINUTES;
};

/** True if `zone` is a timezone this runtime knows. */
const isValidZone = (zone) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; }
  catch { return false; }
};

/**
 * Accepts "+05:30", "-4", "UTC", or an IANA name like "Europe/Berlin".
 * Returns the value to store in `tz`, or null if unparseable.
 */
const parseTimezone = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^(utc|gmt|z)$/i.test(s)) return 0;

  const off = s.match(/^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (off) {
    const sign = off[1] === '-' ? -1 : 1;
    const h = parseInt(off[2], 10), m = parseInt(off[3] ?? '0', 10);
    if (h > 14 || m > 59) return null;
    return sign * (h * 60 + m);
  }
  if (/^[A-Za-z]+(?:[_/][A-Za-z_-]+)+$/.test(s) && isValidZone(s)) return s;
  return null;
};

// ─── The picker list ──────────────────────────────────────────────────────────
// Asking someone to type "Europe/Berlin" assumes they know their zone's name.
// Most people do not — but everyone knows what time it is where they are. So the
// picker shows each zone's *current local clock*, and you choose the row that
// matches your watch. Names are the places this server actually plays from,
// widest coverage first; 25 is Discord's hard cap on select options.
const COMMON_ZONES = [
  ['Asia/Kolkata',        'India'],
  ['UTC',                 'UTC'],
  ['Europe/London',       'UK, Ireland, Portugal'],
  ['Europe/Berlin',       'Germany, France, Spain, Italy, Poland'],
  ['Europe/Athens',       'Greece, Finland, Romania, Ukraine'],
  ['Europe/Moscow',       'Russia (Moscow)'],
  ['America/New_York',    'US East — New York, Toronto, Miami'],
  ['America/Chicago',     'US Central — Chicago, Dallas'],
  ['America/Denver',      'US Mountain — Denver, Phoenix'],
  ['America/Los_Angeles', 'US West — LA, Seattle, Vancouver'],
  ['America/Sao_Paulo',   'Brazil'],
  ['America/Mexico_City', 'Mexico'],
  ['America/Argentina/Buenos_Aires', 'Argentina'],
  ['Asia/Dubai',          'UAE, Oman'],
  ['Asia/Karachi',        'Pakistan'],
  ['Asia/Dhaka',          'Bangladesh'],
  ['Asia/Kathmandu',      'Nepal'],
  ['Asia/Jakarta',        'Indonesia (west)'],
  ['Asia/Singapore',      'Singapore, Malaysia'],
  ['Asia/Manila',         'Philippines'],
  ['Asia/Shanghai',       'China, Hong Kong'],
  ['Asia/Tokyo',          'Japan'],
  ['Asia/Seoul',          'South Korea'],
  ['Australia/Sydney',    'Australia (east)'],
  ['Pacific/Auckland',    'New Zealand'],
];

/** Local wall-clock time in a zone right now, e.g. "10:32 PM". */
const clockIn = (zone, at = Date.now()) => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone === 'UTC' ? 'UTC' : zone,
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(at));
  } catch {
    return '';
  }
};

/**
 * Picker rows, sorted west to east so the list reads like a globe. Each row
 * carries the zone's current time, which is the part people actually recognise.
 */
const zoneChoices = (at = Date.now()) =>
  COMMON_ZONES
    .map(([zone, where]) => ({
      zone, where,
      offset: zone === 'UTC' ? 0 : resolveOffset(zone, at),
      clock: clockIn(zone, at),
    }))
    .sort((a, b) => a.offset - b.offset);

const describeTz = (tz) => {
  if (typeof tz === 'string') {
    const mins = resolveOffset(tz);
    const sign = mins < 0 ? '-' : '+';
    const a = Math.abs(mins);
    return `${tz} (UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)} right now)`;
  }
  const mins = tz ?? DEFAULT_TZ_MINUTES;
  const sign = mins < 0 ? '-' : '+';
  const a = Math.abs(mins);
  return `UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};

// userId → { startMin, endMin, tz }
const configs = new Map();

// userId → Map<command, { channel, at }> waiting for the window to end
const deferred = new Map();

// userId → timeout handle for the flush
const flushTimers = new Map();

const parseWindow = (raw, defaultTz = DEFAULT_TZ_MINUTES) => {
  const m = String(raw ?? '').trim()
    .match(/^(\d{1,2}):(\d{2})\s*(?:-|–|to)\s*(\d{1,2}):(\d{2})(?:\s*([+-]\d{1,2}):?(\d{2})?)?$/i);
  if (!m) return null;

  const startMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const endMin   = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  if (startMin > 1439 || endMin > 1439) return null;
  if (startMin === endMin) return null; // a zero-length or all-day window is never what's meant

  let tz = defaultTz;
  if (m[5]) {
    const sign = m[5].startsWith('-') ? -1 : 1;
    tz = sign * (Math.abs(parseInt(m[5], 10)) * 60 + parseInt(m[6] ?? '0', 10));
  }
  return { startMin, endMin, tz };
};

// Minutes past midnight in the config's timezone.
const localMinutes = (cfg, at = Date.now()) => {
  const shifted = new Date(at + resolveOffset(cfg.tz, at) * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

/**
 * Is `at` inside this window? Exported so per-command pauses can reuse the same
 * midnight-crossing logic rather than reimplementing it slightly differently.
 */
const withinWindow = (cfg, at = Date.now()) => {
  if (!cfg || cfg.startMin == null || cfg.endMin == null) return false;
  const now = localMinutes({ tz: cfg.tz }, at);
  return cfg.startMin < cfg.endMin
    ? now >= cfg.startMin && now < cfg.endMin
    : now >= cfg.startMin || now < cfg.endMin;   // crosses midnight
};

const describeWindow = (cfg) => {
  if (!cfg) return '';
  return `${asClock(cfg.startMin)}–${asClock(cfg.endMin)} (${describeTz(cfg.tz)})`;
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
  return cfg ? describeWindow(cfg) : null;
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
  withinWindow, describeWindow,
  parseTimezone, describeTz, resolveOffset, isValidZone,
  zoneChoices, clockIn, COMMON_ZONES,
  deferReminder, flush, loadAll, pendingCount, DEFAULT_TZ_MINUTES,
};
