// ─── Daily digest ─────────────────────────────────────────────────────────────
// At each 00:00 UTC reset, post what the previous day actually amounted to:
// XP, ryo, dailies cleared, feeds done. Everything is already recorded — this
// just reads the window back.

const { XpEvent } = require('./models/xp');
const { FeedLog, Dailies, DailyResult } = require('./models/tracking');
const { lastDailyReset } = require('./xptracker');

const DAY_MS = 86_400_000;
const fmt = (n) => Number(n).toLocaleString('en-US');

let timer = null;

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Persist how the finished day went, so streaks survive the 14-day snapshot TTL.
 * Idempotent on (userId, day).
 */
const recordResult = async (userId, stats) => {
  const day = dayKey(new Date(lastDailyReset().getTime() - 1)); // the day that just ended
  try {
    await DailyResult.updateOne(
      { userId, day },
      { $set: { ...stats, at: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) console.error(`[digest] result write failed: ${err.message}`);
  }
};

/** Consecutive completed days, counting back from the most recent recorded day. */
const streak = async (userId) => {
  const rows = await DailyResult.find({ userId }).sort({ day: -1 }).limit(400).lean();
  if (!rows.length) return { current: 0, best: 0, days: 0 };

  let current = 0;
  for (const r of rows) {
    if (!r.completed) break;
    current++;
  }

  let best = 0, run = 0;
  // rows are newest-first; a gap in dates also breaks a run
  let prev = null;
  for (const r of [...rows].reverse()) {
    const gap = prev && (Date.parse(r.day) - Date.parse(prev)) !== DAY_MS;
    if (!r.completed || gap) run = r.completed ? 1 : 0;
    else run++;
    best = Math.max(best, run);
    prev = r.day;
  }

  return { current, best, days: rows.length };
};

const streakReport = async (userId) => {
  const s = await streak(userId);
  if (!s.days) {
    return `<@${userId}> no completed days recorded yet — streaks start from the next reset.`;
  }
  const flame = s.current >= 7 ? '🔥🔥' : s.current > 0 ? '🔥' : '💤';
  return [
    `<@${userId}> ${flame} **dailies streak**`,
    `> current: **${s.current}** day(s)`,
    `> best: **${s.best}** day(s)`,
    `-# from ${s.days} recorded day(s) — a day counts only if every daily was cleared before reset`,
  ].join('\n');
};

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

  const tasksDone  = snap?.tasks?.filter(t => t.done >= t.total).length ?? 0;
  const tasksTotal = snap?.tasks?.length ?? 0;
  await recordResult(userId, {
    completed: tasksTotal > 0 && tasksDone === tasksTotal,
    tasksDone, tasksTotal, xp, ryo, feeds,
  });

  const bySource = {};
  for (const e of events) bySource[e.source] = (bySource[e.source] ?? 0) + 1;

  const lines = [`<@${userId}> 🌅 **yesterday**`];

  if (xp)  lines.push(`> 📈 **+${fmt(xp)} xp**`);
  if (ryo) lines.push(`> 💰 ${ryo >= 0 ? '+' : '−'}${fmt(Math.abs(ryo))} ryo net`);
  if (Object.keys(bySource).length) {
    lines.push(`> 🎯 ${Object.entries(bySource).map(([k, v]) => `${v}× ${k}`).join(' · ')}`);
  }
  if (feeds) lines.push(`> 🍜 ${feeds} ninja(s) fed`);

  if (tasksTotal) {
    lines.push(`> 📜 dailies ${tasksDone}/${tasksTotal}` +
      (tasksDone === tasksTotal ? ' ✅' : ' — missed some'));
  }

  const s = await streak(userId);
  if (s.current > 0) lines.push(`> 🔥 **${s.current}** day streak`);

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

module.exports = { build, scheduleDaily, msUntilNextReset, streak, streakReport, recordResult };
