// ─── Dailies tracker ──────────────────────────────────────────────────────────
// Reads the `n d` page and nudges you before the 00:00 UTC (05:30 IST) reset if
// anything is still unfinished. Since the Aug 2026 patch dailies are the main
// Monthly Pass EXP source, so an unfinished set is real value lost.
//
// Page shape (Components V2), captured verbatim:
//   ## mxrxsxki.'s dailies
//   Resets <t:1787961600:R> ⏰
//   **Complete 0/30 missions** (2000 ryo)
//   **Challenge 0/3 players** (10 weapon tickets)
//   **Daily Chest bar** — `0/600` 🔐

const { Dailies } = require('./models/tracking');
const { trace } = require('./debug');

// How long before reset to nudge.
const NUDGE_LEAD_MS = 3 * 60 * 60 * 1000;

const P = {
  header: /'s dailies\b/i,
  task:   /\*\*(Complete|Challenge|Perform)\s+([\d,]+)\/([\d,]+)\s+([^*]+?)\*\*(?:\s*\(([^)]+)\))?/gi,
  chest:  /Daily Chest bar\*{0,2}\s*[—\-–]\s*`?([\d,]+)\/([\d,]+)`?/i,
  reset:  /Resets\s*<t:(\d+)/i,
};

const num = (s) => parseInt(String(s).replace(/[,\s]/g, ''), 10);

// userId → timeout handle for the pending nudge
const nudges = new Map();

const parse = (text) => {
  if (!P.header.test(text)) return null;

  const tasks = [];
  P.task.lastIndex = 0;
  for (const m of text.matchAll(P.task)) {
    const [, verb, done, total, label, reward] = m;
    tasks.push({
      label:  `${verb} ${label.trim()}`.replace(/\s+/g, ' '),
      done:   num(done),
      total:  num(total),
      reward: reward?.trim() ?? null,
    });
  }
  if (!tasks.length) return null;

  const chest = text.match(P.chest);
  const reset = text.match(P.reset);

  return {
    tasks,
    chestDone:  chest ? num(chest[1]) : null,
    chestTotal: chest ? num(chest[2]) : null,
    resetAt:    reset ? new Date(num(reset[1]) * 1000) : null,
  };
};

const record = async (userId, channelId, parsed) => {
  try {
    await Dailies.create({ userId, channelId, ...parsed });
  } catch (err) {
    console.error(`[dailies] write failed: ${err.message}`);
  }
};

const latest = (userId) => Dailies.findOne({ userId }).sort({ at: -1 }).lean();

const remaining = (snap) => (snap?.tasks ?? []).filter(t => t.done < t.total);

const fmt = (n) => Number(n).toLocaleString('en-US');

const report = async (userId) => {
  const snap = await latest(userId);
  if (!snap) {
    return `<@${userId}> no dailies data yet — run \`n d\` once and I'll start tracking it.`;
  }

  const left  = remaining(snap);
  const done  = snap.tasks.length - left.length;
  const reset = snap.resetAt ? `<t:${Math.floor(new Date(snap.resetAt).getTime() / 1000)}:R>` : 'unknown';

  const lines = [
    `<@${userId}> **dailies** — ${done}/${snap.tasks.length} complete · resets ${reset}`,
  ];

  for (const t of snap.tasks) {
    const pct  = t.total ? Math.min(1, t.done / t.total) : 0;
    const bar  = '█'.repeat(Math.round(pct * 10)) + '░'.repeat(10 - Math.round(pct * 10));
    const tick = t.done >= t.total ? '✅' : '⬜';
    lines.push(`${tick} \`${bar}\` **${fmt(t.done)}/${fmt(t.total)}** ${t.label}` +
               (t.reward ? ` -# (${t.reward})` : ''));
  }

  if (snap.chestTotal) {
    const pct = Math.min(1, snap.chestDone / snap.chestTotal);
    const bar = '█'.repeat(Math.round(pct * 10)) + '░'.repeat(10 - Math.round(pct * 10));
    lines.push(`🔐 \`${bar}\` **${fmt(snap.chestDone)}/${fmt(snap.chestTotal)}** Daily Chest`);
  }

  lines.push(`-# updated <t:${Math.floor(new Date(snap.at).getTime() / 1000)}:R>`);
  return lines.join('\n');
};

/**
 * (Re)arm the pre-reset nudge. Called every time we see a dailies page, so the
 * reminder always reflects the newest progress.
 *
 * @param send      async (text) => void — how to deliver the nudge
 * @param isMuted   () => boolean — checked at fire time, not schedule time
 */
const scheduleNudge = (userId, parsed, send, isMuted) => {
  const existing = nudges.get(userId);
  if (existing) clearTimeout(existing);

  if (!parsed.resetAt) return;
  const fireAt = new Date(parsed.resetAt).getTime() - NUDGE_LEAD_MS;
  const delay  = fireAt - Date.now();
  if (delay <= 0) return; // already inside the nudge window for today

  const timer = setTimeout(async () => {
    nudges.delete(userId);
    try {
      if (isMuted?.()) return;
      const snap = await latest(userId);
      const left = remaining(snap);
      if (!left.length) return; // all done — stay quiet

      const reset = snap.resetAt
        ? `<t:${Math.floor(new Date(snap.resetAt).getTime() / 1000)}:R>`
        : 'soon';
      await send(
        `<@${userId}> ⏰ dailies reset ${reset} — still open:\n` +
        left.map(t => `> **${fmt(t.total - t.done)}** more · ${t.label}`).join('\n') +
        `\n-# \`nh off dailies\` to stop these`
      );
    } catch (err) {
      console.error(`[dailies] nudge failed for ${userId}: ${err.message}`);
    }
  }, delay);

  timer.unref();
  nudges.set(userId, timer);
  trace('dailies nudge armed', { userId, inMinutes: Math.round(delay / 60000) });
};

/** Rebuild pending nudges after a restart. */
const restoreNudges = async (resolveChannel, isMuted) => {
  try {
    const recent = await Dailies.aggregate([
      { $sort: { at: -1 } },
      { $group: { _id: '$userId', doc: { $first: '$$ROOT' } } },
    ]);

    let armed = 0;
    for (const { doc } of recent) {
      if (!doc.resetAt || new Date(doc.resetAt) <= new Date()) continue;
      if (!remaining(doc).length) continue;

      const channel = await resolveChannel(doc.channelId);
      if (!channel) continue;

      scheduleNudge(doc.userId, doc, (t) => channel.send(t), () => isMuted(doc.userId));
      armed++;
    }
    console.log(`[startup] Armed ${armed} dailies nudge(s).`);
  } catch (err) {
    console.error('[dailies] Could not restore nudges:', err.message);
  }
};

module.exports = { parse, record, report, scheduleNudge, restoreNudges, latest, remaining };
