// ─── Monthly Pass tracker ─────────────────────────────────────────────────────
// `n pass` has 60 levels a month (120 for Deluxe, 180 for Ultra) and every
// `n daily` action feeds it. The useful question is "am I on pace to finish
// before the month rolls over" — which needs level, progress, and the date.
//
// UNVERIFIED: no `n pass` page has been captured yet, so the patterns below are
// deliberately loose and each is tried independently. Whatever fails to match is
// simply left null rather than guessed, and `nh pass` says what it could not
// read. Run `n pass` with DEBUG_CAPTURE on and these get pinned down properly.

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

const MAX_LEVEL = { free: 60, deluxe: 60, ultra: 60 }; // 60 levels; higher tiers add rewards, not levels

const num = (s) => parseInt(String(s).replace(/[,\s]/g, ''), 10);
const fmt = (n) => Number(n).toLocaleString('en-US');

const P = {
  header: /'s (?:monthly )?pass\b/i,
  level:  /(?:\blevel\b|\blvl\b)[^\d]{0,8}(\d{1,3})/i,
  bar:    /([\d,]+)\s*\/\s*([\d,]+)(?:\s*(?:xp|exp|points))?/i,
  deluxe: /\bdeluxe\b/i,
  ultra:  /\bultra\b/i,
};

const parse = (text) => {
  if (!P.header.test(text)) return null;

  const level = text.match(P.level);
  const bar   = text.match(P.bar);
  const tier  = P.ultra.test(text) ? 'ultra' : P.deluxe.test(text) ? 'deluxe' : 'free';

  if (!level && !bar) return null;   // header matched but nothing readable

  return {
    level:  level ? num(level[1]) : null,
    xp:     bar ? num(bar[1]) : null,
    needed: bar ? num(bar[2]) : null,
    tier,
  };
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

  const days = daysLeftInMonth();
  const cap  = MAX_LEVEL[snap.tier] ?? 60;
  const lines = [`<@${userId}> 💎 **Monthly Pass**` + (snap.tier !== 'free' ? ` · ${snap.tier}` : '')];

  if (snap.level != null) {
    const remaining = Math.max(0, cap - snap.level);
    const pct = Math.min(100, (snap.level / cap) * 100);
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    lines.push(`\`${bar}\` **level ${snap.level}/${cap}**`);

    if (remaining === 0) {
      lines.push(`✅ maxed for this month`);
    } else {
      const perDay = remaining / Math.max(0.5, days);
      lines.push(
        `> **${remaining}** level(s) to go · **${days.toFixed(1)} day(s)** left in the month\n` +
        `> pace needed: **${perDay.toFixed(1)} level(s)/day**`
      );
    }
  } else {
    lines.push('-# level not readable from the page — see below');
  }

  if (snap.xp != null && snap.needed != null) {
    lines.push(`> this level: **${fmt(snap.xp)} / ${fmt(snap.needed)}**`);
  }

  const missing = [
    snap.level == null && 'level',
    snap.xp == null && 'progress',
  ].filter(Boolean);
  if (missing.length) {
    lines.push(`-# couldn't read: ${missing.join(', ')} — the page format needs a look`);
  }

  lines.push(`-# read <t:${Math.floor(new Date(snap.at).getTime() / 1000)}:R> · \`n pass\` to refresh`);
  return lines.join('\n');
};

module.exports = { parse, record, report, latest, Pass, daysLeftInMonth };
