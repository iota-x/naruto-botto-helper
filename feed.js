// ─── Feed routine ─────────────────────────────────────────────────────────────
// Saves the daily `n feed` list and, more usefully, tracks which lines you have
// already run today so you never have to remember where you left off.
//
// Pasting seven lines into Discord sends ONE message, so a copy-everything block
// cannot actually be replayed — the real saving is knowing the next single
// command to send. `nh feed` therefore leads with that, and ticks entries off by
// watching for your own `n feed` messages.
//
//   nh feed                      show the routine and what's left today
//   nh feed add 223 rl           append — just id and item; "n feed" is optional
//   nh feed set <lines…>         replace the whole routine (multi-line friendly)
//   nh feed remove 4             remove by position
//   nh feed remove 223 rl        remove the first matching entry
//   nh feed clear                delete the routine
//   nh feed done                 mark everything done for today
//   nh feed usage                syntax reminder

const { FeedRoutine, FeedLog } = require('./models/tracking');
const { lastDailyReset } = require('./xptracker');

// Exp per item, from the in-game values.
const ITEMS = {
  rl:  { label: 'Ramen (L)',           xp: 5000 },
  rm:  { label: 'Ramen (M)',           xp: 2500 },
  rs:  { label: 'Ramen (S)',           xp: 1000 },
  bcs: { label: 'Birthday Cake Slice', xp: 3000 },
};

// The in-game alias for Birthday Cake Slice is unconfirmed; accept the likely
// spellings and normalise them so the XP total stays correct either way.
const ALIASES = { cake: 'bcs', bc: 'bcs', slice: 'bcs', birthdaycakeslice: 'bcs' };

const normItem = (raw) => {
  const k = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return ALIASES[k] ?? k;
};

const itemInfo = (item) => ITEMS[normItem(item)] ?? null;
const fmt = (n) => Number(n).toLocaleString('en-US');

// Accepts "n feed 223 rl", "feed 223 rl", "223 rl" — one per line.
const parseEntries = (raw) => {
  const entries = [];
  const bad = [];
  for (const line of String(raw ?? '').split('\n')) {
    const t = line.trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!t) continue;
    const m = t.match(/^(?:n\s+)?(?:feed\s+)?(\d+)\s+(\S+)$/i);
    if (m) entries.push({ unitId: m[1], item: normItem(m[2]) });
    else bad.push(t);
  }
  return { entries, bad };
};

// The `n feed` items page, captured verbatim:
//   ### eiota's items
//   **Ramen (L)**: 22 / **Ramen (M)**: 35 / **Ramen (S)**: 46
//   **Birthday Cake Slice**: 1
const STOCK_LABELS = { rl: 'Ramen \\(L\\)', rm: 'Ramen \\(M\\)', rs: 'Ramen \\(S\\)', bcs: 'Birthday Cake Slice' };

const parseStock = (text) => {
  if (!/'s items\b/i.test(text)) return null;
  const out = {};
  let any = false;
  for (const [key, label] of Object.entries(STOCK_LABELS)) {
    const m = text.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*([\\d,]+)`, 'i'));
    if (m) { out[key] = parseInt(m[1].replace(/,/g, ''), 10); any = true; }
  }
  return any ? out : null;
};

// Latest known stock per user, in memory — cheap and only a display nicety.
const stockCache = new Map();
const recordStock = (userId, stock) => stockCache.set(userId, { stock, at: Date.now() });
const getStock = (userId) => stockCache.get(userId) ?? null;

const getRoutine = (userId) => FeedRoutine.findOne({ userId }).lean();

const saveRoutine = (userId, entries) =>
  FeedRoutine.findOneAndUpdate(
    { userId },
    { $set: { entries, updatedAt: new Date() } },
    { upsert: true, new: true }
  ).lean();

/** Record an observed `n feed`. Idempotent on message id. */
const logFeed = async (userId, unitId, item, key) => {
  try {
    await FeedLog.updateOne(
      { key },
      { $setOnInsert: { userId, unitId, item: normItem(item), key, at: new Date() } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (err.code !== 11000) console.error(`[feed] log failed: ${err.message}`);
    return false;
  }
};

const todaysLog = (userId) =>
  FeedLog.find({ userId, at: { $gte: lastDailyReset() } }).lean();

/**
 * Match today's feeds against the routine.
 *
 * Each ninja can only be fed once per 24h, so matching is by unit id alone — if
 * you fed 265 an rm when the routine said rl, the line is still satisfied and
 * the daily allowance is spent. A second line for a ninja already listed can
 * never be satisfied; it comes back as 'blocked' rather than pending.
 */
const progress = (entries, log) => {
  const fed = new Map();          // unitId → item actually used
  for (const l of log) fed.set(l.unitId, normItem(l.item));

  const claimed = new Set();
  return entries.map(e => {
    if (claimed.has(e.unitId)) return { state: 'blocked' };
    claimed.add(e.unitId);

    if (!fed.has(e.unitId)) return { state: 'pending' };
    const used = fed.get(e.unitId);
    return { state: 'done', usedItem: used !== normItem(e.item) ? used : null };
  });
};

// One feed per ninja per day, so only the first line for each id can pay out.
const routineXp = (entries) => {
  const seen = new Set();
  return entries.reduce((sum, e) => {
    if (seen.has(e.unitId)) return sum;
    seen.add(e.unitId);
    return sum + (itemInfo(e.item)?.xp ?? 0);
  }, 0);
};

const duplicateIds = (entries) => {
  const seen = new Map();
  for (const e of entries) seen.set(e.unitId, (seen.get(e.unitId) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
};

const line = (e) => `n feed ${e.unitId} ${e.item}`;

const usage = (userId) => [
  `<@${userId}> **feed routine**`,
  '> `nh feed` — show the routine and what is still due today',
  '> `nh feed set <lines>` — replace it (paste all your lines at once)',
  '> `nh feed add 223 rl` — append one (the `n feed` prefix is optional)',
  '> `nh feed remove 4` / `nh feed remove 223 rl` — remove by position or content',
  '> `nh feed done` — mark everything done · `nh feed clear` — delete the routine',
  `-# items: ${Object.entries(ITEMS).map(([k, v]) => `\`${k}\` ${v.label} +${fmt(v.xp)}`).join(' · ')}`,
].join('\n');

const show = async (userId) => {
  const routine = await getRoutine(userId);
  const entries = routine?.entries ?? [];

  if (!entries.length) {
    return `<@${userId}> no feed routine saved yet. Paste yours in one go — ` +
      `just id and item, one per line:\n` +
      '```\nnh feed set\n223 rl\n265 rl\n152 rm\n```';
  }

  const states  = progress(entries, await todaysLog(userId));
  const doable  = states.filter(s => s.state !== 'blocked').length;
  const done    = states.filter(s => s.state === 'done').length;
  const pending = entries.filter((_, i) => states[i].state === 'pending');
  const first   = states.findIndex(s => s.state === 'pending');

  const lines = [
    `<@${userId}> 🍜 **feed routine** — ${done}/${doable} done today`,
  ];

  if (first !== -1) lines.push(`▶️ next: \`${line(entries[first])}\``);
  else if (done === doable) lines.push('✅ all done for today');

  lines.push('');
  entries.forEach((e, i) => {
    const info = itemInfo(e.item);
    const s = states[i];
    const mark = s.state === 'done'    ? '✅'
               : s.state === 'blocked' ? '⚠️'
               : i === first           ? '▶️' : '⬜';

    let note = info ? ` -# ${info.label} +${fmt(info.xp)}` : ' -# ⚠️ unknown item';
    if (s.state === 'blocked') note = ` -# ⚠️ **${e.unitId}** is already fed above — one item per ninja per day`;
    else if (s.usedItem) note = ` -# fed **${itemInfo(s.usedItem)?.label ?? s.usedItem}** instead`;

    lines.push(`${mark} \`${line(e)}\`${note}`);
  });

  const dupes = duplicateIds(entries);
  if (dupes.length) {
    lines.push(
      `\n⚠️ **${dupes.join(', ')}** listed more than once. Each ninja can only be fed ` +
      `once per 24h, so the extra line will never work — \`nh feed remove <n>\` and add the ninja you meant.`
    );
  }

  const xp = routineXp(entries);
  if (xp) lines.push(`-# routine grants **+${fmt(xp)} xp** across ${doable} feedable ninja(s)`);

  // How many more days the routine can run on current stock.
  const held = getStock(userId);
  if (held) {
    const need = {};
    const counted = new Set();
    for (const e of entries) {
      if (counted.has(e.unitId)) continue;
      counted.add(e.unitId);
      const k = normItem(e.item);
      need[k] = (need[k] ?? 0) + 1;
    }
    const runway = Object.entries(need)
      .filter(([k]) => held.stock[k] != null)
      .map(([k, per]) => Math.floor(held.stock[k] / per));
    const days = runway.length ? Math.min(...runway) : null;

    lines.push(
      `-# stock: ${Object.entries(held.stock).map(([k, v]) => `\`${k}\` ${fmt(v)}`).join(' · ')}` +
      (days != null ? ` → **${days} day(s)** of this routine` : '') +
      ` (as of <t:${Math.floor(held.at / 1000)}:R>)`
    );
  }

  if (pending.length) {
    lines.push('', 'Still due — send these one at a time:');
    lines.push('```\n' + pending.map(line).join('\n') + '\n```');
  }
  return lines.join('\n');
};

/**
 * Handle any `nh feed …` input. `rest` is everything after the command word,
 * with original casing and newlines preserved.
 */
const command = async (userId, rest) => {
  const trimmed = String(rest ?? '').trim();
  const [word, ...tail] = trimmed.split(/\s+/);
  const sub = (word ?? '').toLowerCase();
  // Everything after the subcommand, newlines intact
  const args = trimmed.slice(word?.length ?? 0).trim();

  if (!trimmed || sub === 'list' || sub === 'show') return show(userId);
  if (sub === 'usage' || sub === '?') return usage(userId);

  if (sub === 'set') {
    const { entries, bad } = parseEntries(args);
    if (!entries.length) {
      return `<@${userId}> couldn't read any feed lines. Try:\n\`\`\`\nnh feed set\n223 rl\n152 rm\n\`\`\``;
    }
    await saveRoutine(userId, entries);
    return `<@${userId}> saved **${entries.length}** feed line(s)` +
      (bad.length ? ` · skipped ${bad.length} unreadable: ${bad.map(b => `\`${b}\``).join(', ')}` : '') +
      `\n${await show(userId)}`;
  }

  if (sub === 'add') {
    const { entries, bad } = parseEntries(args);
    if (!entries.length) return `<@${userId}> couldn't read that. Example: \`nh feed add 223 rl\``;

    const routine  = await getRoutine(userId);
    const existing = routine?.entries ?? [];
    const have     = new Set(existing.map(e => e.unitId));

    // One item per ninja per 24h — a second line for the same id can never run.
    const clash = [], fresh = [];
    for (const e of entries) {
      if (have.has(e.unitId)) clash.push(e);
      else { have.add(e.unitId); fresh.push(e); }
    }

    if (!fresh.length) {
      return `<@${userId}> **${clash.map(e => e.unitId).join(', ')}** already in your routine — ` +
        `each ninja can only be fed once per day. Use \`nh feed remove <id> <item>\` first if you want to change the item.`;
    }

    await saveRoutine(userId, [...existing, ...fresh]);
    return `<@${userId}> added **${fresh.length}**` +
      (clash.length ? ` · skipped **${clash.map(e => e.unitId).join(', ')}** (already fed in this routine)` : '') +
      (bad.length ? ` · ${bad.length} unreadable` : '') +
      `\n${await show(userId)}`;
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'del') {
    const routine = await getRoutine(userId);
    const entries = [...(routine?.entries ?? [])];
    if (!entries.length) return `<@${userId}> no routine to remove from.`;

    // By position: "nh feed remove 4" — but "remove 223 rl" is by content.
    const asIndex = args.match(/^(\d+)$/);
    if (asIndex) {
      const i = parseInt(asIndex[1], 10) - 1;
      if (i < 0 || i >= entries.length) {
        return `<@${userId}> position must be 1–${entries.length}.`;
      }
      const [gone] = entries.splice(i, 1);
      await saveRoutine(userId, entries);
      return `<@${userId}> removed \`${line(gone)}\`.\n${await show(userId)}`;
    }

    const { entries: want } = parseEntries(args);
    if (!want.length) return `<@${userId}> use \`nh feed remove 4\` or \`nh feed remove 223 rl\`.`;
    const target = want[0];
    const idx = entries.findIndex(e => e.unitId === target.unitId && normItem(e.item) === target.item);
    if (idx === -1) return `<@${userId}> \`${line(target)}\` isn't in your routine.`;
    const [gone] = entries.splice(idx, 1);
    await saveRoutine(userId, entries);
    return `<@${userId}> removed \`${line(gone)}\`.\n${await show(userId)}`;
  }

  if (sub === 'clear') {
    await FeedRoutine.deleteOne({ userId });
    return `<@${userId}> feed routine deleted.`;
  }

  if (sub === 'done') {
    const routine = await getRoutine(userId);
    const entries = routine?.entries ?? [];
    if (!entries.length) return `<@${userId}> no routine saved.`;
    const stamp = Date.now();
    await Promise.all(entries.map((e, i) =>
      logFeed(userId, e.unitId, e.item, `manual:${userId}:${stamp}:${i}`)
    ));
    return `<@${userId}> marked all ${entries.length} feeds done for today.`;
  }

  // Bare "nh feed 223 rl" is a natural way to add one.
  const { entries } = parseEntries(trimmed);
  if (entries.length) return command(userId, `add ${trimmed}`);

  return usage(userId);
};

/**
 * Undo a feed log — used when the game refuses the command for a reason that
 * means the ninja did *not* eat. "Already eaten a daily food" is deliberately
 * not one of those: the ninja is fed either way, so the routine line stands.
 */
const unlogFeed = async (key) => {
  try {
    const res = await FeedLog.deleteOne({ key });
    return res.deletedCount > 0;
  } catch (err) {
    console.error(`[feed] unlog failed: ${err.message}`);
    return false;
  }
};

module.exports = {
  command, show, logFeed, unlogFeed, ITEMS, normItem, itemInfo, parseEntries,
  parseStock, recordStock, getStock,
};
