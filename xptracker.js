// ─── XP tracker ───────────────────────────────────────────────────────────────
// Reads XP out of the pages the game bot already sends, so nothing has to be
// armed by hand:
//
//   n tr <tier>  → "Each ninja in your team gained `3630` xp" plus, per ninja,
//                  "**Lvl**: 119 · **Exp**: 2047054 -> 2050684"
//   n r (edited) → "Ninjas in team gained 308 xp"
//   n m (edited) → "You earned 206 ryō!"   (ryo only, no xp)
//   n t          → footer "… | 2046995/5500000XP" + "(id:223)" — the only place
//                  the level-up threshold appears
//
// Gains give an exact rate; `n t` gives the target. Together they answer
// "how much did I gain today" and "how long until this ninja levels".

const { XpSample, XpEvent } = require('./models/xp');
const { trace } = require('./debug');

const num = (s) => parseInt(String(s).replace(/[,\s]/g, ''), 10);

// "Isshiki Ōtsutsuki (Celestial Being)" / "Isshiki Ōtsutsuki (Lv.119)" → base name
const normaliseName = (raw) => raw.split(' (')[0].trim();

// ─── Patterns (all taken from captured traffic) ──────────────────────────────

const P = {
  trainHeader: /'s (?:noob|basic|advanced|expert|pro) training\b/i,
  trainGain:   /each ninja in your team gained\*{0,2}\s*`?([\d,]+)`?/i,
  trainCost:   /cost:?\*{0,2}\s*`?([\d,]+)`?/i,
  // "**Lvl**: 119 · **Exp**: 2047054 -> 2050684"  (normal)
  // "**Lvl**: 1 -> 2 · **Exp**: 780"              (levelled up)
  ninjaLine:   /\*\*([^*\n]+?)\*\*\s*\n\*\*Lvl\*\*:\s*(\d+)(?:\s*->\s*(\d+))?\s*·\s*\*\*Exp\*\*:\s*([\d,]+)(?:\s*->\s*([\d,]+))?/g,
  reportGain:  /ninjas in team gained\s*([\d,]+)\s*xp/i,
  ryoEarned:   /you earned\s*([\d,]+)\s*ry/i,
  teamXp:      /([\d,]+)\/([\d,]+)\s*XP/i,
  teamId:      /\(id:(\d+)\)/i,
  teamLevel:   /\(Lv\.(\d+)\)/i,
};

const DAY_MS = 86_400_000;

const lastDailyReset = () => {
  const now = Date.now();
  const d = new Date(now);
  let reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0);
  if (reset > now) reset -= DAY_MS;
  return new Date(reset);
};

// ─── Ingest ──────────────────────────────────────────────────────────────────

const saveEvent = async (userId, source, amount, ryo, key) => {
  if (!amount && !ryo) return false;
  try {
    await XpEvent.updateOne(
      { key },                                   // message id — an edit re-fires
      { $setOnInsert: { userId, source, amount, ryo, key, at: new Date() } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err.code !== 11000) console.error(`[xp] event write failed: ${err.message}`);
    return false;
  }
};

const saveSample = async (userId, sample) => {
  try {
    await XpSample.create({ userId, at: new Date(), ...sample });
  } catch (err) {
    console.error(`[xp] sample write failed: ${err.message}`);
  }
};

/**
 * Feed every game-bot page through here. Returns a short label when something
 * was recorded, so the caller can log it. Never throws.
 */
const observe = async (message, text, userId) => {
  if (!userId) return null;
  const id = message.id;

  try {
    // ── Training: team-wide gain + a full snapshot of every ninja ───────────
    if (P.trainHeader.test(text)) {
      const gain = text.match(P.trainGain);
      const cost = text.match(P.trainCost);
      const amount = gain ? num(gain[1]) : 0;
      await saveEvent(userId, 'train', amount, cost ? -num(cost[1]) : 0, `${id}:train`);

      let seen = 0;
      P.ninjaLine.lastIndex = 0;
      for (const m of text.matchAll(P.ninjaLine)) {
        const [, rawName, lvl, lvlAfter, exp, expAfter] = m;
        await saveSample(userId, {
          name:  normaliseName(rawName),
          level: num(lvlAfter ?? lvl),
          xp:    num(expAfter ?? exp),
        });
        seen++;
      }
      return `train +${amount} xp, ${seen} ninja snapshot(s)`;
    }

    // ── Report result (arrives as an edit) ─────────────────────────────────
    const reportGain = text.match(P.reportGain);
    if (reportGain) {
      const ryo = text.match(P.ryoEarned);
      await saveEvent(userId, 'report', num(reportGain[1]), ryo ? num(ryo[1]) : 0, `${id}:report`);
      return `report +${num(reportGain[1])} xp`;
    }

    // ── Mission result (ryo only) ──────────────────────────────────────────
    if (/rank mission/i.test(text)) {
      const ryo = text.match(P.ryoEarned);
      if (ryo) {
        await saveEvent(userId, 'mission', 0, num(ryo[1]), `${id}:mission`);
        return `mission +${num(ryo[1])} ryo`;
      }
      return null;
    }

    // ── Team page: the only source of the level-up threshold ───────────────
    const teamXp = text.match(P.teamXp);
    if (teamXp) {
      const unitId = text.match(P.teamId)?.[1] ?? null;
      const level  = text.match(P.teamLevel)?.[1] ?? null;
      const title  = text.split('\n').find(l => P.teamLevel.test(l)) ?? '';
      const name   = normaliseName(title.replace(/\*/g, '')) || 'unknown';
      await saveSample(userId, {
        name, unitId,
        level:  level ? num(level) : null,
        xp:     num(teamXp[1]),
        needed: num(teamXp[2]),
      });
      return `snapshot ${name} ${num(teamXp[1])}/${num(teamXp[2])}`;
    }
  } catch (err) {
    console.error(`[xp] observe failed: ${err.message}`);
  }
  return null;
};

// ─── Reporting ───────────────────────────────────────────────────────────────

const fmt = (n) => Number(n).toLocaleString('en-US');

const humanDuration = (hours) => {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
};

const sumGains = async (userId, since) => {
  const rows = await XpEvent.find({ userId, at: { $gte: since } }).lean();
  return rows.reduce((acc, r) => ({
    xp:  acc.xp  + (r.amount || 0),
    ryo: acc.ryo + (r.ryo    || 0),
    n:   acc.n + 1,
  }), { xp: 0, ryo: 0, n: 0 });
};

// XP/hour over a window. Uses the full window as the denominator so a short
// burst of play doesn't project an absurd rate; falls back to time-since-first
// event when there is less than a window's worth of history.
const ratePerHour = async (userId, windowHours = 24) => {
  const since = new Date(Date.now() - windowHours * 3600_000);
  const rows  = await XpEvent.find({ userId, at: { $gte: since }, amount: { $gt: 0 } })
    .sort({ at: 1 }).lean();
  if (!rows.length) return { rate: 0, total: 0, spanHours: windowHours };

  const total    = rows.reduce((s, r) => s + r.amount, 0);
  const earliest = await XpEvent.findOne({ userId, amount: { $gt: 0 } }).sort({ at: 1 }).lean();
  const historyHours = earliest ? (Date.now() - new Date(earliest.at).getTime()) / 3600_000 : windowHours;
  const spanHours = Math.max(0.25, Math.min(windowHours, historyHours));

  return { rate: total / spanHours, total, spanHours };
};

// Latest known position per ninja, merging the threshold from `n t` with the
// fresher xp/level that training pages provide.
const currentUnits = async (userId) => {
  const rows = await XpSample.find({ userId }).sort({ at: -1 }).limit(400).lean();
  const byName = new Map();

  for (const row of rows) {                 // newest first
    const cur = byName.get(row.name) ?? { name: row.name };
    if (cur.xp == null)     { cur.xp = row.xp; cur.level = row.level; cur.at = row.at; }
    if (cur.needed == null && row.needed != null) {
      cur.needed = row.needed;
      cur.neededLevel = row.level;
      cur.unitId = row.unitId ?? cur.unitId;
    }
    if (cur.unitId == null && row.unitId) cur.unitId = row.unitId;
    byName.set(row.name, cur);
  }
  return [...byName.values()];
};

/** Full `nh xp` report. Returns a Discord-ready string. */
const report = async (userId, unitFilter = null) => {
  const [today, day, week, units] = await Promise.all([
    sumGains(userId, lastDailyReset()),
    ratePerHour(userId, 24),
    ratePerHour(userId, 24 * 7),
    currentUnits(userId),
  ]);

  if (!units.length && today.n === 0) {
    return `<@${userId}> no XP data yet — run \`n t\` once to record your ninjas, ` +
           `then \`n tr\` and \`n r\` will keep it updated automatically.`;
  }

  const lines = [
    `<@${userId}> **XP tracker**`,
    `📅 Since reset: **+${fmt(today.xp)} xp**` +
      (today.ryo ? ` · ${today.ryo >= 0 ? '+' : ''}${fmt(today.ryo)} ryo` : '') +
      ` (${today.n} action${today.n === 1 ? '' : 's'})`,
    `⚡ Rate: **~${fmt(Math.round(day.rate))} xp/hr** over ${humanDuration(day.spanHours)}` +
      (week.rate ? ` · 7d avg ~${fmt(Math.round(week.rate))}/hr` : ''),
  ];

  const shown = unitFilter
    ? units.filter(u => u.unitId === unitFilter || u.name.toLowerCase().includes(unitFilter.toLowerCase()))
    : units;

  if (!shown.length) {
    lines.push('', `No ninja matching **${unitFilter}**.`);
    return lines.join('\n');
  }

  lines.push('');
  for (const u of shown.slice(0, 8)) {
    const head = `**${u.name}**${u.level ? ` · Lv.${u.level}` : ''}${u.unitId ? ` · id:${u.unitId}` : ''}`;

    if (u.needed == null) {
      lines.push(`${head}\n> ${fmt(u.xp)} xp — run \`n t\` on this ninja to learn its level target`);
      continue;
    }
    // The threshold was read at a possibly older level; flag rather than lie.
    const stale = u.neededLevel != null && u.level != null && u.neededLevel !== u.level;
    const remaining = Math.max(0, u.needed - u.xp);
    const pct = Math.min(100, (u.xp / u.needed) * 100);
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));

    const eta = day.rate > 0 ? humanDuration(remaining / day.rate) : null;
    const at  = day.rate > 0
      ? `<t:${Math.floor((Date.now() + (remaining / day.rate) * 3600_000) / 1000)}:R>`
      : '';

    lines.push(
      `${head}\n> \`${bar}\` ${pct.toFixed(1)}%  ${fmt(u.xp)} / ${fmt(u.needed)}` +
      `\n> remaining **${fmt(remaining)}** · ` +
      (eta ? `level up in **${eta}** (${at})` : 'no recent activity to estimate from') +
      (stale ? `\n> -# target read at Lv.${u.neededLevel} — run \`n t\` to refresh` : '')
    );
  }

  if (units.length > shown.length) lines.push(`-# ${units.length - shown.length} more — \`nh xp <name>\``);
  return lines.join('\n');
};

module.exports = { observe, report, lastDailyReset, normaliseName };
