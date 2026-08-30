// ─── Invasion ─────────────────────────────────────────────────────────────────
// The Ōtsutsuki clan invades daily. You sign your ninja list in defence during
// one of two 45-minute windows, and the invasion resolves after 22:00 UTC:
//
//   09:00–09:45 UTC   (14:30–15:15 IST)
//   21:00–21:45 UTC   (02:30–03:15 IST)
//
// Signing is allowed up to three times, but a re-sign only *refreshes* the power
// read from `n list` — it does not stack. So one sign is all anyone needs, and
// the reminders stop for the day as soon as a sign is seen.
//
// Two windows means two chances at the same reward, not two rewards. Each window
// announces itself exactly once, to people who have actually played recently —
// see scheduleWindows.

const { InvasionSign } = require('./models/tracking');
const { trace } = require('./debug');

const WINDOW_MS = 45 * 60 * 1000;
const WINDOWS = [
  { name: 'morning', utcHour: 9,  utcMin: 0 },
  { name: 'evening', utcHour: 21, utcMin: 0 },
];

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

const windowStart = (w, dayOffset = 0, at = Date.now()) => {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayOffset,
                  w.utcHour, w.utcMin);
};

/** The window open right now, or null. */
const currentWindow = (at = Date.now()) => {
  for (const w of WINDOWS) {
    const start = windowStart(w, 0, at);
    if (at >= start && at < start + WINDOW_MS) return { ...w, start, end: start + WINDOW_MS };
  }
  return null;
};

/** The next window to open, today or tomorrow. */
const nextWindow = (at = Date.now()) => {
  const upcoming = WINDOWS
    .flatMap(w => [0, 1].map(off => ({ ...w, start: windowStart(w, off, at) })))
    .filter(w => w.start > at)
    .sort((a, b) => a.start - b.start);
  const w = upcoming[0];
  return w ? { ...w, end: w.start + WINDOW_MS } : null;
};

// ─── Reading the game bot's confirmation ──────────────────────────────────────
// The exact reply, captured from a real sign:
//
//   Your 294 ninjas of 8135309 power (including 61% boost) were signed for
//   invasion defense **eiota**!
//   //Remaining re-signs (power refreshes): 1
//
// The boost clause is optional — a player with no boost will not have it — so it
// is matched separately rather than being required by the main pattern.
const P = {
  sign: /Your\s+([\d,]+)\s+ninjas?\s+of\s+([\d,]+)\s+power.*?were signed for invasion defen[cs]e\s+\*{0,2}([^*!\n]+?)\*{0,2}\s*!/is,
  boost: /including\s+(\d+)\s*%\s*boost/i,
  resigns: /Remaining re-signs[^:]*:\s*(\d+)/i,
  guide: /Invasion guide\s*-\s*Current time/i,
};

const num = (s) => parseInt(String(s).replace(/,/g, ''), 10);

/** Returns the parsed sign, or null when this is not a sign confirmation. */
const parseSign = (text) => {
  const m = text.match(P.sign);
  if (!m) return null;
  const boost   = text.match(P.boost);
  const resigns = text.match(P.resigns);
  return {
    ninjas:   num(m[1]),
    power:    num(m[2]),
    boost:    boost ? parseInt(boost[1], 10) : null,
    username: m[3].trim(),
    resignsLeft: resigns ? parseInt(resigns[1], 10) : null,
  };
};

// userId → { day, power, ninjas, boost, resignsLeft, at }
const signs = new Map();

const signedToday = (userId, at = Date.now()) =>
  signs.get(userId)?.day === dayKey(at);

const lastSign = (userId) => signs.get(userId) ?? null;

/** Record a sign. Idempotent per day — a re-sign just updates the power. */
const recordSign = async (userId, info, at = Date.now()) => {
  const day = dayKey(at);
  signs.set(userId, { day, ...info, at });
  trace('invasion signed', { userId, ...info });
  try {
    await InvasionSign.findOneAndUpdate(
      { userId, day },
      { $set: { ...info, at: new Date(at) } },
      { upsert: true }
    );
  } catch (err) {
    console.error(`[invasion] could not record sign for ${userId}: ${err.message}`);
  }
};

/** Warm the in-memory view of who has signed today, after a restart. */
const loadToday = async (at = Date.now()) => {
  try {
    const day  = dayKey(at);
    const rows = await InvasionSign.find({ day });
    for (const r of rows) {
      signs.set(r.userId, {
        day, power: r.power, ninjas: r.ninjas, boost: r.boost,
        resignsLeft: r.resignsLeft, at: r.at?.getTime?.() ?? at,
      });
    }
    return rows.length;
  } catch (err) {
    console.error('[invasion] could not load today\'s signs:', err.message);
    return 0;
  }
};

/** One line for `nh next` and the daily digest. */
const nextLine = (userId, at = Date.now()) => {
  const open = currentWindow(at);
  const sign = signs.get(userId);

  if (sign?.day === dayKey(at)) {
    const power = sign.power?.toLocaleString?.() ?? sign.power;
    return `⚔️ **Invasion** — signed ✅ · ${power} power` +
           (sign.boost ? ` (incl. ${sign.boost}% boost)` : '');
  }
  if (open) {
    return `⚔️ **Invasion** — sign now, window shuts <t:${Math.floor(open.end / 1000)}:R> · \`n invasion sign\``;
  }
  const next = nextWindow(at);
  return next
    ? `⚔️ **Invasion** — not signed · next window <t:${Math.floor(next.start / 1000)}:R>`
    : null;
};

let timer = null;

// `${userId}:${YYYY-MM-DD}:${window}` for everyone already told about a window.
// One ping per person per window, and nothing can make it two — the spam on
// 29 Aug was 67 rounds to the same 12 people because the only thing standing
// between a scheduling bug and 800 mentions was the scheduling bug not happening.
const notified = new Set();

const notifyKey = (userId, w, at = Date.now()) => `${userId}:${dayKey(at)}:${w?.name ?? '?'}`;

/**
 * Announce each window once, to people who are actually playing.
 *
 * Three rules, each learned the hard way:
 *
 *   once      one ping per person per window, tracked explicitly. The reschedule
 *             used to re-enter the window it had just fired in, so it fired
 *             again a second later, and again — 67 rounds before the window
 *             closed. The dedup set means even a scheduling bug cannot spam.
 *   active    only people who have played in the last 24h. The database holds
 *             everyone who ever ran a command, and pinging someone who last
 *             played in April is pure noise.
 *   quiet     a held ping is useless here: the evening window is 02:30 IST and
 *             a reminder delivered at breakfast is about a window that shut
 *             hours ago. Inside quiet hours it is skipped, not deferred.
 */
const scheduleWindows = (listUsers, resolveChannel, isMuted, isQuiet) => {
  if (timer) clearTimeout(timer);

  const now    = Date.now();
  // Always aim at the next window to *open*. Never re-enter the current one:
  // that is what turned one last call into 67.
  const target = nextWindow(now);
  if (!target) return;

  const fireAt = target.start;

  timer = setTimeout(async () => {
    try {
      // Captured, not re-derived: a setTimeout can come due a few milliseconds
      // early, and at the boundary currentWindow() would still say "none".
      const w = target;
      const users = await listUsers();
      let sent = 0, skipped = 0;

      for (const { userId, channelId } of users) {
        const key = notifyKey(userId, w, w.start);
        if (notified.has(key)) { skipped++; continue; }   // already told, this window
        if (isMuted(userId, 'invasion')) continue;
        if (signedToday(userId, w.start)) continue;       // nothing left to say
        if (isQuiet(userId)) continue;                    // would land after it shuts

        const channel = await resolveChannel(channelId);
        if (!channel) continue;

        notified.add(key);   // set before sending: a send that throws must not retry forever
        try {
          await channel.send(
            `<@${userId}> ⚔️ **invasion sign-up is open** — shuts <t:${Math.floor(w.end / 1000)}:R>\n` +
            `> \`n invasion sign\` (or \`n i s\`) · re-signing only refreshes power\n` +
            `-# \`nh off invasion\` to stop these`
          );
          sent++;
        } catch (err) {
          console.warn(`[invasion] send failed for ${userId}: ${err.message}`);
        }
      }
      console.log(`[invasion] ${w.name} window open — notified ${sent} active player(s)` +
        (skipped ? `, ${skipped} already told` : '') + '.');

      // Housekeeping: yesterday's keys are dead weight.
      if (notified.size > 2000) notified.clear();
    } catch (err) {
      console.error('[invasion] run failed:', err.message);
    } finally {
      scheduleWindows(listUsers, resolveChannel, isMuted, isQuiet);
    }
  }, Math.max(1000, fireAt - now));

  timer.unref();
  console.log(`[invasion] Next window (${target.name}) in ${Math.round((fireAt - now) / 60000)}m.`);
};

module.exports = {
  P, parseSign, recordSign, loadToday, signedToday, lastSign, nextLine,
  currentWindow, nextWindow, scheduleWindows, WINDOWS, WINDOW_MS, dayKey,
};
