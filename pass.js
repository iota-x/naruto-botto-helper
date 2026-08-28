// ─── Monthly Pass tracker ─────────────────────────────────────────────────────
// `n pass` has 60 levels a month (120 for Deluxe, 180 for Ultra) and every
// `n daily` action feeds it. The useful question is "am I on pace to finish
// before the month rolls over" — which needs level, progress, and the date.
//
// Captured page, verbatim:
//   ## eiota's Monthly Pass 💎
//   🔵 **`lvl1 `** — ⚡ 240x +70exp for completed mission
//   🟡 **`lvl2 `** — 💰 15,000 Ryo          … ten per page, "1/6" pages = 60 levels
//   **Collect `125/1750` exp** to reach **level 2** ⭐
//
// and on level-up:
//   ### Monthly Pass rewards claimed! 💎
//   You reached and claimed level 1 and received the following items **eiota**!
//
// Note the page explains Free/Deluxe/Ultra to *everyone*, so the words "deluxe"
// and "ultra" appear regardless of what you own — tier is deliberately not
// inferred from this page rather than reported wrongly.

const { Balance } = require('./models/tracking');   // reused store, `pass` field
const mongoose = require('mongoose');

const PassSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  level:  { type: Number, default: null },
  xp:     { type: Number, default: null },
  needed: { type: Number, default: null },
  tier:   { type: String, default: null },   // free | deluxe | ultra
  at:     { type: Date, default: Date.now, expires: '90d' },
});
PassSchema.index({ userId: 1, at: -1 });
const Pass = mongoose.models.pass ?? mongoose.model('pass', PassSchema, 'passes');

// 60 levels a month for everyone; Deluxe/Ultra multiply the rewards, not the count.
const MAX_LEVEL = 60;

const num = (s) => parseInt(String(s).replace(/[,\s]/g, ''), 10);
const fmt = (n) => Number(n).toLocaleString('en-US');

const P = {
  header:  /'s Monthly Pass\b/i,
  // "**Collect `125/1750` exp** to reach **level 2** ⭐"
  collect: /Collect\s*`?\s*([\d,]+)\s*\/\s*([\d,]+)\s*`?\s*exp\*{0,2}\s*to reach\s*\*{0,2}\s*level\s*(\d+)/i,
  // "### Monthly Pass rewards claimed!" / "You reached and claimed level 1"
  claimed: /Monthly Pass rewards claimed/i,
  claimedLevel: /reached and claimed level\s*(\d+)/i,
  maxed:   /max(?:imum)? level|fully completed|all levels/i,
};

const parse = (text) => {
  // Level-up announcement — a firm statement of the level reached.
  if (P.claimed.test(text)) {
    const lv = text.match(P.claimedLevel);
    if (lv) return { level: num(lv[1]), xp: null, needed: null, source: 'claim' };
  }

  if (!P.header.test(text)) return null;

  const c = text.match(P.collect);
  if (c) {
    // "to reach level N" means the level currently held is N-1.
    return {
      level:  Math.max(0, num(c[3]) - 1),
      xp:     num(c[1]),
      needed: num(c[2]),
      source: 'page',
    };
  }

  if (P.maxed.test(text)) return { level: MAX_LEVEL, xp: null, needed: null, source: 'page' };

  return null; // header matched but the progress line moved — report, don't guess
};

const record = async (userId, data) => {
  try { await Pass.create({ userId, ...data }); }
  catch (err) { console.error(`[pass] write failed: ${err.message}`); }
};

const latest = (userId) => Pass.findOne({ userId }).sort({ at: -1 }).lean();

// Days left in the current calendar month, UTC.
const daysLeftInMonth = () => {
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return (end - now.getTime()) / 86_400_000;
};

const report = async (userId) => {
  const snap = await latest(userId);
  if (!snap) {
    return `<@${userId}> no Monthly Pass data yet — run \`n pass\` once and I'll start tracking it.`;
  }

  const days  = daysLeftInMonth();
  const cap   = MAX_LEVEL;
  const level = snap.level ?? 0;
  const lines = [`<@${userId}> 💎 **Monthly Pass**`];

  const remaining = Math.max(0, cap - level);
  const pct = Math.min(100, (level / cap) * 100);
  const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
  lines.push(`\`${bar}\` **level ${level}/${cap}** · ${pct.toFixed(0)}%`);

  if (snap.xp != null && snap.needed != null) {
    lines.push(`> next level: **${fmt(snap.xp)} / ${fmt(snap.needed)}** exp`);
  }

  if (remaining === 0) {
    lines.push('✅ maxed for this month');
  } else {
    const perDay = remaining / Math.max(0.5, days);
    lines.push(
      `> **${remaining}** level(s) to go · **${days.toFixed(1)} day(s)** left this month\n` +
      `> pace needed: **${perDay.toFixed(1)} level(s)/day**`
    );
    // At ~1750 exp a level, say what that costs in daily terms.
    if (snap.needed) {
      lines.push(`-# ≈ ${fmt(Math.round(perDay * snap.needed))} exp/day — all of it from \`n daily\``);
    }
    if (perDay > 3) lines.push(`-# ⚠️ that's a steep pace — finishing 60 may not be realistic`);
  }

  lines.push(`-# read <t:${Math.floor(new Date(snap.at).getTime() / 1000)}:R> · \`n pass\` to refresh`);
  return lines.join('\n');
};

module.exports = { parse, record, report, latest, Pass, daysLeftInMonth };
