// ─── Daily digest ─────────────────────────────────────────────────────────────
// At each 00:00 UTC reset, post what the previous day actually amounted to:
// XP, ryo, dailies cleared, feeds done. Everything is already recorded — this
// just reads the window back.

const { XpEvent } = require('./models/xp');
const { FeedLog, Dailies } = require('./models/tracking');
const { lastDailyReset } = require('./xptracker');

const DAY_MS = 86_400_000;
const fmt = (n) => Number(n).toLocaleString('en-US');

let timer = null;

/** Summary for the day that just ended, or null if nothing happened. */
const build = async (userId) => {
  const end   = lastDailyReset();                       // the reset just passed
  const start = new Date(end.getTime() - DAY_MS);

  const [events, feeds, snap] = await Promise.all([
    XpEvent.find({ userId, at: { $gte: start, $lt: end } }).lean(),
    FeedLog.countDocuments({ userId, at: { $gte: start, $lt: end } }),
    Dailies.findOne({ userId, at: { $gte: start } }).sort({ at: -1 }).lean(),
  ]);

  if (!events.length && !feeds && !snap) return null;

  const xp  = events.reduce((s, e) => s + (e.amount || 0), 0);
  const ryo = events.reduce((s, e) => s + (e.ryo || 0), 0);

  const bySource = {};
  for (const e of events) bySource[e.source] = (bySource[e.source] ?? 0) + 1;

  const lines = [`<@${userId}> 🌅 **yesterday**`];

  if (xp)  lines.push(`> 📈 **+${fmt(xp)} xp**`);
  if (ryo) lines.push(`> 💰 ${ryo >= 0 ? '+' : '−'}${fmt(Math.abs(ryo))} ryo net`);
  if (Object.keys(bySource).length) {
    lines.push(`> 🎯 ${Object.entries(bySource).map(([k, v]) => `${v}× ${k}`).join(' · ')}`);
  }
  if (feeds) lines.push(`> 🍜 ${feeds} ninja(s) fed`);

  if (snap?.tasks?.length) {
    const done = snap.tasks.filter(t => t.done >= t.total).length;
    lines.push(`> 📜 dailies ${done}/${snap.tasks.length}` +
      (done === snap.tasks.length ? ' ✅' : ' — missed some'));
  }

  lines.push(`-# new set is live · \`nh off digest\` to stop this`);
  return lines.join('\n');
};

const msUntilNextReset = () => {
  const now = Date.now();
  const d = new Date(now);
  let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0);
  if (next <= now) next += DAY_MS;
  return next - now;
};

/**
 * Run the digest at every reset.
 *
 * @param listUsers      async () => [{ userId, channelId }]
 * @param resolveChannel async (channelId) => channel | null
 * @param isMuted        (userId) => boolean
 */
const scheduleDaily = (listUsers, resolveChannel, isMuted) => {
  if (timer) clearTimeout(timer);

  const delay = msUntilNextReset() + 30_000; // just after the reset lands
  timer = setTimeout(async () => {
    try {
      const users = await listUsers();
      let sent = 0;
      for (const { userId, channelId } of users) {
        if (isMuted(userId)) continue;
        const text = await build(userId);
        if (!text) continue;
        const channel = await resolveChannel(channelId);
        if (!channel) continue;
        try { await channel.send(text); sent++; }
        catch (err) { console.warn(`[digest] send failed for ${userId}: ${err.message}`); }
      }
      console.log(`[digest] Sent ${sent} daily digest(s).`);
    } catch (err) {
      console.error('[digest] run failed:', err.message);
    } finally {
      scheduleDaily(listUsers, resolveChannel, isMuted); // arm tomorrow
    }
  }, delay);

  timer.unref();
  console.log(`[digest] Next daily digest in ${Math.round(delay / 60000)}m.`);
};

module.exports = { build, scheduleDaily, msUntilNextReset };
