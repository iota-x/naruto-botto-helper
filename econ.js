// ─── Economy tracker ──────────────────────────────────────────────────────────
// Ryo in and out, plus what your balance actually buys. Ryo movements are
// already recorded as XpEvent rows (missions and reports earn, training spends);
// this reads them back and pairs them with `n bal` snapshots.
//
// Balance page is a classic embed:
//   eiota's balance
//   **Ryō:** 963494 / **Special tickets:** 129061 / **Weapon tickets:** 146624 …

const { XpEvent } = require('./models/xp');
const { Balance } = require('./models/tracking');
const { lastDailyReset } = require('./xptracker');

const PULL_COST         = 300;
const SPECIAL_PULL_COST = 500;

const num = (s) => parseInt(String(s).replace(/[,\s]/g, ''), 10);
const fmt = (n) => Number(n).toLocaleString('en-US');

// The balance page writes "Ryō"; the weekly page writes "Ryo". Accept both.
const FIELDS = {
  ryo:        /\*\*Ry[ōo]:?\*\*\s*([\d,]+)/i,
  special:    /\*\*Special tickets:?\*\*\s*([\d,]+)/i,
  weapon:     /\*\*Weapon tickets:?\*\*\s*([\d,]+)/i,
  chakra:     /\*\*Chakra tickets:?\*\*\s*([\d,]+)/i,
  vote:       /\*\*Vote tickets:?\*\*\s*([\d,]+)/i,
  premium:    /\*\*Premium tickets:?\*\*\s*([\d,]+)/i,
  extraction: /\*\*Jutsu Extraction tickets:?\*\*\s*([\d,]+)/i,
};

const parseBalance = (text) => {
  if (!/'s balance\b/i.test(text)) return null;
  const out = {};
  let any = false;
  for (const [key, re] of Object.entries(FIELDS)) {
    const m = text.match(re);
    if (m) { out[key] = num(m[1]); any = true; }
  }
  return any ? out : null;
};

const record = async (userId, balance) => {
  try {
    await Balance.create({ userId, ...balance });
  } catch (err) {
    console.error(`[econ] balance write failed: ${err.message}`);
  }
};

const since = async (userId, from) => {
  const rows = await XpEvent.find({ userId, at: { $gte: from } }).lean();
  const bySource = {};
  let earned = 0, spent = 0;

  for (const r of rows) {
    const ryo = r.ryo || 0;
    if (ryo > 0) earned += ryo; else spent += -ryo;
    const b = bySource[r.source] ?? (bySource[r.source] = { ryo: 0, xp: 0, n: 0 });
    b.ryo += ryo;
    b.xp  += r.amount || 0;
    b.n++;
  }
  return { earned, spent, net: earned - spent, bySource, count: rows.length };
};

/** Total xp across every source in a `since()` result. */
const dayXpOf = (bucket) =>
  Object.values(bucket.bySource).reduce((a, s) => a + (s.xp || 0), 0);

const report = async (userId) => {
  const [today, day, latest] = await Promise.all([
    since(userId, lastDailyReset()),
    since(userId, new Date(Date.now() - 86_400_000)),
    Balance.findOne({ userId }).sort({ at: -1 }).lean(),
  ]);

  if (!today.count && !day.count && !latest) {
    return `<@${userId}> no economy data yet — play a bit, or run \`n bal\` to record your balance.`;
  }

  const sign = (n) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
  const lines = [`<@${userId}> **economy**`];

  // Earned and spent are the numbers people actually want, so they get their own
  // line rather than a parenthetical after the net.
  const todayXp = dayXpOf(today);
  const resetAt = Math.floor(lastDailyReset().getTime() / 1000);

  lines.push(`📅 **Today** — since the reset <t:${resetAt}:R>`);
  lines.push(`> earned **+${fmt(today.earned)}** ryo · spent **−${fmt(today.spent)}** ryo`);
  lines.push(`> net **${sign(today.net)} ryo**${todayXp ? ` · gained **+${fmt(todayXp)} xp**` : ''}`);

  // Deliberately labelled as rolling: it is a 24-hour window ending now, so it
  // overlaps yesterday and will not agree with the figures above. Two people
  // have now read it as "today", which is worth one extra word to prevent.
  if (day.count) {
    lines.push(
      `🕐 **Rolling 24h** — ${sign(day.net)} ryo over ${fmt(day.count)} action(s)` +
      (dayXpOf(day) ? ` · ${sign(dayXpOf(day))} xp` : '')
    );
    lines.push('-# a moving window ending now, so it reaches back into yesterday');
  }

  const sources = Object.entries(today.bySource).sort(([, a], [, b]) => b.n - a.n);
  if (sources.length) {
    lines.push('');
    for (const [name, s] of sources) {
      const per = s.n ? Math.round(s.ryo / s.n) : 0;
      lines.push(
        `> **${name}** ×${s.n} · ${sign(s.ryo)} ryo (${sign(per)}/run)` +
        (s.xp ? ` · +${fmt(s.xp)} xp` : '')
      );
    }
    // Training costs ryo to buy XP — worth surfacing the exchange rate.
    const train = today.bySource.train;
    if (train?.xp > 0 && train.ryo < 0) {
      lines.push(`-# training rate: ${fmt(Math.round(-train.ryo / train.xp * 1000))} ryo per 1,000 xp`);
    }
  }

  if (latest) {
    lines.push('');
    lines.push(
      `💰 Balance: **${fmt(latest.ryo ?? 0)} ryo** · ` +
      `${fmt(latest.special ?? 0)} special · ${fmt(latest.chakra ?? 0)} chakra`
    );
    lines.push(
      `🎲 Affords **${fmt(Math.floor((latest.ryo ?? 0) / PULL_COST))}** pulls · ` +
      `**${fmt(Math.floor((latest.special ?? 0) / SPECIAL_PULL_COST))}** special pulls`
    );
    lines.push(`-# balance read <t:${Math.floor(new Date(latest.at).getTime() / 1000)}:R> — \`n bal\` to refresh`);
  } else {
    lines.push(`-# run \`n bal\` to record your balance and see what it affords`);
  }

  return lines.join('\n');
};

module.exports = { parseBalance, record, report, PULL_COST, SPECIAL_PULL_COST };
