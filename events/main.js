const database = require("../models/user");
const { trace } = require("../debug");
const xptracker = require("../xptracker");
const dailies   = require("../dailies");
const econ      = require("../econ");
const feed      = require("../feed");
const reports   = require("../reports");

// ─── Constants ───────────────────────────────────────────────────────────────

const NARUTO_BOT_ID = '770100332998295572';

// August 2026 patch: quests were folded into `n daily`. Dailies are one set per
// day, auto-claimed, and reset at 00:00 UTC (05:30 IST) — not a rolling 20h.
const DAILY_RESET_UTC_HOUR = 0;

const COOLDOWN_DURATIONS = {
  mission:   60,
  report:    600,
  challenge: 1800,
  train:     3600,
  tower:     21600,
  weekly:    604800,
  buy_v15:   72000,
  buy_v20:   158400,
};

// Commands whose cooldown isn't a fixed span — resolved fresh at arm time.
const DYNAMIC_DURATIONS = {
  daily: () => secondsUntilDailyReset(),
};

// Cooldowns the game no longer has. Dropped on parse and on DB restore so old
// rows can't resurrect a reminder for something that doesn't exist any more.
const RETIRED_COMMANDS = new Set(['quest', 'quests', 'adventure']);

// Names the game bot uses that differ from our internal keys.
const COMMAND_ALIASES = { dailies: 'daily', dq: 'daily' };

// Short cooldowns — kept in memory only, never written to DB
const MEMORY_ONLY = new Set(['mission', 'report']);

// Max age for pending challenge entries before we clean them up
const PENDING_TTL_MS = 5 * 60 * 1000;

// How long we wait for the game bot to confirm a command actually went through
const CONFIRM_WINDOW_MS = 30 * 1000;

// Don't spam a user with "that didn't go through" notices
const NOTICE_THROTTLE_MS = 2 * 60 * 1000;

// ─── Command detection ───────────────────────────────────────────────────────

// What the user typed → which cooldown it *might* start. Nothing is armed off
// this alone; see the pending/confirm flow below.
const COMMAND_PATTERNS = [
  [/^n\s+m(is(sion)?)?\b/i,                                   'mission'],
  [/^n\s+r(ep(ort)?)?\b/i,                                    'report'],
  [/^n\s+d(aily|ailies)?\b/i,                                 'daily'],
  [/^n\s+w(eekly)?\b/i,                                       'weekly'],
  [/^n\s+tr(ain)?(\s+(noob|basic|advanced|expert|pro))?\s*$/i, 'train'],
];

// The game bot said the command did NOT go through. Checked before any
// confirmation pattern — a rejection always wins.
const REJECTION_PATTERNS = [
  /under maintenance/i,
  /on cooldown/i,
  /you (?:are|'re) (?:currently )?(?:in|on|busy)/i,
  /don'?t have (?:enough|any)/i,
  /not enough/i,
  /an error (?:has )?occurred/i,
  /something went wrong/i,
  /(?:please )?try again/i,
  /you (?:need|have) to (?:first|start|register)/i,
  /command is disabled/i,
  /rate ?limit/i,
];

// The game bot confirmed the command ran. First pattern in each list is the
// strict signature; the second is a looser fallback so a wording tweak doesn't
// silently kill reminders. A rejection is checked first, so a loose match can't
// fire off a maintenance/cooldown reply.
//
// Strict patterns below are taken from real captured Components V2 output:
//   "### eiota's B rank mission"          → mission
//   "### eiota's report info"             → report
//   "## mxrxsxki.'s dailies"              → daily
//   "### **slimysludge.'s weekly reward** → weekly
//   "mxrxsxki.'s basic training"          → train
const CONFIRM_PATTERNS = {
  mission: [/\b[A-Z] rank mission\b/i, /\brank mission\b/i],
  report:  [/'s report info\b/i,       /\breport info\b/i],
  daily:   [/'s dailies\b/i,           /\bdailies\b/i],
  weekly:  [/'s weekly reward\b/i,     /\bweekly reward\b/i],
  // Tier is part of the header: "'s noob/basic/advanced/expert/pro training"
  train:   [/'s (?:noob|basic|advanced|expert|pro) training\b/i,
            /\btraining\b|each ninja in your team gained/i],
};

// ─── In-memory state ─────────────────────────────────────────────────────────

// userId → { [command]: unixExpirySeconds }
const cooldownCache = new Map();

// channelId → [{ userId, command, messageId, timestamp }]
// Commands the user typed that are waiting for the game bot to confirm them.
const pendingCommands = new Map();

// userId → timestamp of the last "didn't go through" notice we sent
const failureNotices = new Map();

// channelId → { challengerId, timestamp }
const pendingChallenges = new Map();

// channelId → { challengerId, timestamp }
const recentChallenges = new Map();

// userId — suppresses reminder bursts from "n cd" checks
const cdCheckSuppressed = new Set();

// `${userId}:${unitId}` → { startXp, timestamp, pending, pendingEnd, endChannelId }
const xpSessions = new Map();

// messageId → { info, at, answered } for an in-flight `n r`.
// The info page and the options are edits of the same message, so the id ties
// the two halves together.
const reportRiddles = new Map();

// userId → unixSeconds when pause expires
const pausedUntil = new Map();

// userId → Set of muted command names ("all" mutes everything).
// Backed by user.disabled in Mongo; the schema field existed but nothing ever
// read or wrote it until now.
const mutedCommands = new Map();

const isMuted = (userId, command) => {
  const set = mutedCommands.get(userId);
  return Boolean(set && (set.has('all') || set.has(command)));
};

const setMuted = async (userId, command, muted) => {
  const set = mutedCommands.get(userId) ?? new Set();
  if (muted) set.add(command); else set.delete(command);
  if (command === 'all' && !muted) set.clear();
  mutedCommands.set(userId, set);

  database.collection.findOneAndUpdate(
    { userId },
    { $set: { disabled: Object.fromEntries([...set].map(c => [c, true])) } },
    { upsert: true }
  ).catch(err => console.error(`[db] mute write failed for ${userId}: ${err.message}`));
};

// Reminder counters — stats.reminders existed in the schema but was never
// incremented, so /stats always showed zeros.
const bumpStat = (userId, command) => {
  database.collection.findOneAndUpdate(
    { userId },
    { $inc: { [`stats.reminders.${command}`]: 1 } },
    { upsert: true }
  ).catch(err => console.error(`[db] stat bump failed for ${userId}: ${err.message}`));
};

// ─── Stale-entry cleanup (every 10 min) ──────────────────────────────────────
// Prevents the channel-keyed maps leaking when a fight or command is ignored
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingChallenges)
    if (now - v.timestamp > PENDING_TTL_MS) pendingChallenges.delete(k);
  for (const [k, v] of recentChallenges)
    if (now - v.timestamp > PENDING_TTL_MS) recentChallenges.delete(k);
  for (const [k, v] of failureNotices)
    if (now - v > NOTICE_THROTTLE_MS) failureNotices.delete(k);
  for (const [k, v] of reportRiddles)
    if (now - v.at > PENDING_TTL_MS) reportRiddles.delete(k);
  for (const [channelId, list] of pendingCommands) {
    const kept = list.filter(p => now - p.timestamp <= CONFIRM_WINDOW_MS);
    if (kept.length) pendingCommands.set(channelId, kept);
    else pendingCommands.delete(channelId);
  }
}, 10 * 60 * 1000).unref(); // .unref() — won't keep the process alive by itself

// ─── Helpers ─────────────────────────────────────────────────────────────────

const retry = async (fn, retries = 4, delay = 1000) => {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      console.warn(`[retry ${i + 1}/${retries}] ${err.message} — next in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
};

// Never throws — silently logs if channel is deleted/inaccessible
const safeSend = (channel, content) =>
  retry(() => channel.send(content)).catch(err =>
    console.error(`[safeSend] channel ${channel.id}: ${err.message}`)
  );

// username → userId for everyone we've seen speak. The game bot names people in
// its page headers but never mentions them, and client.users.cache is unreliable,
// so this is the dependable way to turn "eiota" back into an id.
const knownUsers = new Map();

const rememberUser = (user) => {
  if (user?.username) knownUsers.set(user.username.toLowerCase(), user.id);
};

const findUserByUsername = (client, username) => {
  const key = String(username ?? '').toLowerCase();
  const id  = knownUsers.get(key);
  if (id) return { id, username: key };
  return client.users.cache.find(u => u.username.toLowerCase() === key) ?? null;
};

const resolveUserId = (client, username) => findUserByUsername(client, username)?.id ?? null;

const formatDuration = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const parseTimeString = (str) => {
  if (!str) return 0;
  const units = { d: 86400, h: 3600, m: 60, s: 1 };
  return str.split(' ').reduce((total, part) => {
    const unit = part.slice(-1);
    const amount = parseInt(part);
    return total + (amount * (units[unit] ?? 0));
  }, 0);
};

// Seconds until the next daily reset (00:00 UTC / 05:30 IST).
const secondsUntilDailyReset = () => {
  const now = Date.now();
  const d   = new Date(now);
  let next  = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DAILY_RESET_UTC_HOUR);
  if (next <= now) next += 86_400_000;
  return Math.ceil((next - now) / 1000);
};

const nextDailyResetUnix = () => Math.floor(Date.now() / 1000) + secondsUntilDailyReset();

const normalizeCommand = (name) => {
  const lower = name.toLowerCase();
  return COMMAND_ALIASES[lower] ?? lower;
};

const durationFor = (command) =>
  DYNAMIC_DURATIONS[command] ? DYNAMIC_DURATIONS[command]() : COOLDOWN_DURATIONS[command];

// Since the Aug 2026 patch the game bot sends Components V2 messages: `content`
// is null, `embeds` is empty, and every line lives in a TextDisplay nested
// inside Container/Section components. Walk the tree and collect the text.
const walkComponents = (nodes, out = []) => {
  for (const node of nodes ?? []) {
    const data = node?.data ?? node ?? {};
    if (typeof data.content === 'string') out.push(data.content);
    if (typeof data.label === 'string') out.push(data.label);
    for (const key of ['components', 'accessory', 'items']) {
      const child = node?.[key] ?? data?.[key];
      if (Array.isArray(child)) walkComponents(child, out);
      else if (child) walkComponents([child], out);
    }
  }
  return out;
};

// Everything the game bot put in a message — content, embeds and components.
const messageText = (message) => {
  const parts = [message.content ?? ''];
  for (const embed of message.embeds ?? []) {
    parts.push(embed.title ?? '', embed.description ?? '',
               embed.footer?.text ?? '', embed.author?.name ?? '');
    for (const field of embed.fields ?? []) parts.push(field.name ?? '', field.value ?? '');
  }
  try {
    parts.push(...walkComponents(message.components));
  } catch (err) {
    console.warn(`[components] Could not read message ${message.id}: ${err.message}`);
  }
  return parts.join('\n');
};

// The V2 pages head with the owner's name: "### eiota's B rank mission",
// "## mxrxsxki.'s dailies", "### **slimysludge.'s weekly reward**". The game
// bot sends no mentions at all, so this is the only way to attribute a reply.
const extractOwner = (text) => {
  // Preferred: a markdown heading — "## mxrxsxki.'s dailies"
  const heading = text.match(/(?:^|\n)\s*#{1,3}\s*\*{0,2}\s*([^\n'*]+?)'s\b/);
  if (heading) return heading[1].trim().toLowerCase();

  // Fallback: some pages title without a heading ("mxrxsxki.'s basic training").
  // Only the first non-empty line, so a stray "Kakuzu's" in the body can't win.
  const firstLine = text.split('\n').find(l => l.trim().length) ?? '';
  const plain = firstLine.match(/^\s*\*{0,2}\s*([^'*]{1,40}?)'s\b/);
  if (plain) return plain[1].trim().toLowerCase();

  // Last resort: classic embeds name the owner away from the first line —
  // the team footer is "eiota's ninjas -- 1/4 (id:223)".
  const anywhere = text.match(/([^\s'*][^'\n*]{0,38}?)'s (?:ninjas|cooldowns|balance)\b/i);
  return anywhere ? anywhere[1].trim().toLowerCase() : null;
};

// Where the bot states the real cooldown, use it instead of our fixed table.
const DURATION_FROM_TEXT = {
  // "Resets <t:1787961600:R> ⏰"
  daily: (text) => {
    const m = text.match(/resets?\s*<t:(\d+)/i);
    return m ? parseInt(m[1]) - Math.floor(Date.now() / 1000) : null;
  },
  // "🎁 Your next weekly reward is in **6d 23h 54m 21s**."
  weekly: (text) => {
    const m = text.match(/next weekly reward is in\s*\*{0,2}\s*([0-9dhms\s]+)/i);
    return m ? parseTimeString(m[1].trim()) : null;
  },
};

// ─── Pause / resume ───────────────────────────────────────────────────────────

const pauseReminders = (userId, seconds) => {
  pausedUntil.set(userId, Math.floor(Date.now() / 1000) + seconds);
  setTimeout(() => {
    if ((pausedUntil.get(userId) ?? 0) <= Math.floor(Date.now() / 1000))
      pausedUntil.delete(userId);
  }, seconds * 1000).unref();
};

const resumeReminders = (userId) => pausedUntil.delete(userId);

const isReminderPaused = (userId) => {
  const until = pausedUntil.get(userId);
  return until ? until > Math.floor(Date.now() / 1000) : false;
};

// ─── Cooldown core ────────────────────────────────────────────────────────────

const isOnCooldown = (userId, command) => {
  const expiry = cooldownCache.get(userId)?.[command];
  return expiry ? expiry > Math.floor(Date.now() / 1000) : false;
};

// How much we trust a cooldown value. A better-sourced number is allowed to
// correct a worse one — without this, the first (often hardcoded) guess was
// frozen in for its whole duration because saveCooldown refused to update an
// already-armed cooldown. That is how buy_v15 kept firing minutes early.
const AUTHORITY = {
  table:   0,  // hardcoded guess in COOLDOWN_DURATIONS
  derived: 1,  // computed by us, e.g. next 00:00 UTC
  stated:  2,  // the game bot told us: `n cd` remaining, <t:…>, "6d 23h 54m"
};

// userId → { [command]: authority }
const cooldownAuthority = new Map();
const getAuthority = (userId, command) => cooldownAuthority.get(userId)?.[command] ?? -1;
const setAuthority = (userId, command, level) => {
  const m = cooldownAuthority.get(userId) ?? {};
  m[command] = level;
  cooldownAuthority.set(userId, m);
};

/**
 * Fire a reminder, guarding against firing early.
 *
 * A long setTimeout can come due before its wall-clock deadline — the process
 * being suspended and resumed, the system clock moving, or the timer simply
 * drifting. Re-checking the clock here makes an early ping structurally
 * impossible: if there is time left, we just reschedule.
 */
const armTimer = (userId, command, expiryUnix, channel) => {
  const fire = () => {
    if (cooldownCache.get(userId)?.[command] !== expiryUnix) return; // superseded
    const left = expiryUnix - Math.floor(Date.now() / 1000);
    if (left > 0) {
      console.warn(`[cooldown] ${command} for ${userId} came due ${left}s early — rescheduling`);
      setTimeout(fire, left * 1000).unref();
      return;
    }
    if (isReminderPaused(userId)) return;
    if (isMuted(userId, command)) return;
    bumpStat(userId, command);
    safeSend(channel, `<@${userId}> your **${command}** is ready!`);
  };

  const delay = Math.max(0, (expiryUnix - Math.floor(Date.now() / 1000)) * 1000);
  setTimeout(fire, delay).unref();
};

/**
 * Returns true if a reminder was registered or corrected, false if it was a no-op.
 * `opts.authority` says how trustworthy the duration is — see AUTHORITY above.
 */
const saveCooldown = async (userId, command, cooldownSeconds, channel, client, opts = {}) => {
  const authority = opts.authority ?? AUTHORITY.table;

  if (RETIRED_COMMANDS.has(command)) return false;
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0) return false;

  const now        = Math.floor(Date.now() / 1000);
  const expiryUnix = now + cooldownSeconds;
  const channelId  = channel.id;
  const existing   = cooldownCache.get(userId)?.[command];

  if (existing && existing > now) {
    const prev  = getAuthority(userId, command);
    const drift = expiryUnix - existing;

    if (authority < prev) return false;             // never downgrade a good value
    if (Math.abs(drift) <= 60) return false;        // close enough, keep the armed timer

    console.log(
      `[cooldown] correcting ${command} for ${userId}: ${drift > 0 ? '+' : ''}${drift}s ` +
      `(authority ${prev} → ${authority})`
    );
    trace('cooldown corrected', { command, driftSeconds: drift, from: prev, to: authority });
  }

  // Update memory cache
  const userCache = cooldownCache.get(userId) ?? {};
  userCache[command] = expiryUnix;
  cooldownCache.set(userId, userCache);
  setAuthority(userId, command, authority);

  // Arm the reminder timer
  if (cooldownSeconds > 0) armTimer(userId, command, expiryUnix, channel);

  // Persist to DB — fire-and-forget, never blocks the message handler
  if (!MEMORY_ONLY.has(command)) {
    database.collection.findOneAndUpdate(
      { userId },
      { $set: { [`cooldowns.${command}`]: { expiry: expiryUnix, channelId } } },
      { upsert: true }
    ).catch(err => console.error(`[db] write failed for ${userId}/${command}: ${err.message}`));
  }

  return true;
};

// ─── Pending command confirmation ────────────────────────────────────────────
// The game bot can swallow a command (maintenance, cooldown, an error) and
// still leave the user's `n m` sitting in chat. Typing a command therefore only
// *arms an intent*; the cooldown is registered when the game bot's reply proves
// the command actually ran.

const armPending = (message, command) => {
  const channelId = message.channel.id;
  const list = pendingCommands.get(channelId) ?? [];

  // One intent per user+command — a retype replaces the old one
  const dupe = list.findIndex(p => p.userId === message.author.id && p.command === command);
  if (dupe !== -1) list.splice(dupe, 1);

  list.push({
    userId:    message.author.id,
    username:  message.author.username.toLowerCase(),
    command,
    messageId: message.id,
    timestamp: Date.now(),
  });
  pendingCommands.set(channelId, list);
  trace(`arm ${command}`, { user: message.author.username, waitingOn: 'game bot confirmation' });
};

// Which pending intent is this bot message about?
// Reply > owner name in the page header > mention > oldest for that command.
// Name matching does the real work: V2 pages carry no mentions at all.
const pickPending = (list, message, command, text) => {
  const replyTo  = message.reference?.messageId ?? null;
  const owner    = text ? extractOwner(text) : null;
  const targetId = message.mentions?.users?.first()?.id ?? null;

  const matches = (p) => (command === null || p.command === command);

  let idx = replyTo ? list.findIndex(p => p.messageId === replyTo && matches(p)) : -1;
  if (idx === -1 && owner)    idx = list.findIndex(p => p.username === owner && matches(p));
  if (idx === -1 && targetId) idx = list.findIndex(p => p.userId === targetId && matches(p));

  // Never guess across users — if the page names someone, only they can own it.
  if (idx === -1 && owner) return null;
  if (idx === -1) idx = list.findIndex(matches);
  if (idx === -1) return null;

  const [entry] = list.splice(idx, 1);
  return entry;
};

const notifyFailure = async (channel, userId, command, reason) => {
  const last = failureNotices.get(userId) ?? 0;
  if (Date.now() - last < NOTICE_THROTTLE_MS) return;
  failureNotices.set(userId, Date.now());
  await safeSend(channel,
    `<@${userId}> your **${command}** didn't go through${reason ? ` (${reason})` : ''} — no reminder set.`
  );
};

/**
 * Runs on every game-bot message. Confirms or discards armed intents.
 * Returns true if it consumed the message as a confirmation.
 */
const resolvePendingCommands = async (message, client) => {
  const channelId = message.channel.id;
  const list      = pendingCommands.get(channelId);
  const text      = messageText(message);

  const prune = () => {
    if (!list) return;
    if (list.length) pendingCommands.set(channelId, list);
    else pendingCommands.delete(channelId);
  };

  if (list?.length) {
    const now = Date.now();
    for (let i = list.length - 1; i >= 0; i--) {
      if (now - list[i].timestamp > CONFIRM_WINDOW_MS) list.splice(i, 1);
    }
  }

  // Arms `entry`'s cooldown and removes it from the pending list.
  const commit = async (entry) => {
    const idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
    prune();

    // The bot usually states the real cooldown ("Resets <t:...>", "next weekly
    // reward is in 6d 23h..."). Trust that over our fixed table when present.
    const stated = DURATION_FROM_TEXT[entry.command]?.(text) ?? null;
    const source = stated !== null && stated > 0 ? 'stated' : 'table';
    const seconds = source === 'stated' ? stated : durationFor(entry.command);

    const armed = await saveCooldown(entry.userId, entry.command, seconds, message.channel, client, {
      authority: source === 'stated' ? AUTHORITY.stated
               : DYNAMIC_DURATIONS[entry.command] ? AUTHORITY.derived
               : AUTHORITY.table,
    });
    console.log(`[confirm] ${entry.command} ${armed ? 'confirmed' : 'already tracked'} for ${entry.username} (${seconds}s, ${source})`);
    trace(`commit ${entry.command}`, {
      user: entry.username, seconds, durationSource: source,
      matchedOwner: extractOwner(text), waited: `${Date.now() - entry.timestamp}ms`,
    });
    return true;
  };

  // ── Strict confirmation wins outright ────────────────────────────────────
  // A real "rank mission" embed is a success even if the same message happens
  // to mention a cooldown elsewhere in its text.
  if (list?.length) {
    for (const command of new Set(list.map(p => p.command))) {
      if (!CONFIRM_PATTERNS[command]?.[0]?.test(text)) continue;
      const entry = pickPending(list, message, command, text);
      if (entry) return commit(entry);
    }
  }

  // ── Rejection: the command was refused, so nothing is on cooldown ─────────
  if (list?.length && REJECTION_PATTERNS.some(re => re.test(text))) {
    const reason = /under maintenance/i.test(text) ? 'bot maintenance'
                 : /on cooldown/i.test(text)       ? 'still on cooldown'
                 : 'the game bot refused it';

    // Attribute the refusal if we can (reply id, page owner, mention).
    // Otherwise it's a channel-wide failure like maintenance — drop everything,
    // since arming a reminder off a refused command is the bug we're fixing.
    const identifiable = message.reference?.messageId
      || extractOwner(text)
      || message.mentions?.users?.first();

    const specific = identifiable ? pickPending(list, message, null, text) : null;
    const dropped  = specific ? [specific] : list.splice(0, list.length);
    prune();

    for (const entry of dropped) {
      console.log(`[confirm] dropped ${entry.command} for ${entry.username} — ${reason}`);
      trace(`drop ${entry.command}`, {
        user: entry.username, reason,
        attributed: Boolean(specific), owner: extractOwner(text),
      });
      await notifyFailure(message.channel, entry.userId, entry.command, reason);
    }
    return true;
  }

  // ── Loose confirmation: the game bot replied, not a refusal, and the text
  //    reads like this command's output. Guards against wording drift.
  if (list?.length) {
    for (const command of new Set(list.map(p => p.command))) {
      if (!CONFIRM_PATTERNS[command]?.some(re => re.test(text))) continue;
      const entry = pickPending(list, message, command, text);
      if (entry) return commit(entry);
    }
  }
  prune();

  // ── No armed intent, but a strict confirmation naming a user we can resolve
  // Covers restarts and commands run before we saw the trigger message. V2
  // pages carry no mentions, so the header name is the only handle we have.
  const owner = extractOwner(text);
  const user  = owner ? findUserByUsername(client, owner) : (message.mentions?.users?.first() ?? null);
  if (user) {
    for (const [command, patterns] of Object.entries(CONFIRM_PATTERNS)) {
      if (!patterns[0].test(text)) continue;
      const stated  = DURATION_FROM_TEXT[command]?.(text) ?? null;
      const seconds = stated !== null && stated > 0 ? stated : durationFor(command);
      await saveCooldown(user.id, command, seconds, message.channel, client, {
        authority: stated !== null && stated > 0 ? AUTHORITY.stated
                 : DYNAMIC_DURATIONS[command] ? AUTHORITY.derived
                 : AUTHORITY.table,
      });
      trace(`commit ${command} (no armed intent)`, { user: user.username, seconds });
      return true;
    }
  }

  // Nothing matched. This is the case to watch when reminders go quiet: the
  // game bot said something we have no pattern for.
  if (list?.length) {
    trace('no match', {
      owner:   extractOwner(text),
      pending: list.map(p => `${p.username}:${p.command}`),
      preview: text.replace(/\s+/g, ' ').slice(0, 160),
    });
  }

  return false;
};

// ─── Startup: restore cooldowns from DB ──────────────────────────────────────

const restoreCooldownsFromDB = async (client) => {
  console.log('[startup] Restoring cooldowns from DB...');
  try {
    const now   = Math.floor(Date.now() / 1000);
    const users = await database.find({}).lean();
    let restored = 0;

    for (const user of users) {
      if (!user.cooldowns || typeof user.cooldowns !== 'object') continue;

      const userCache = {};

      for (const [rawCommand, entry] of Object.entries(user.cooldowns)) {
        const command = normalizeCommand(rawCommand);
        if (RETIRED_COMMANDS.has(command)) continue;      // quests no longer exist
        if (!entry?.expiry || !entry?.channelId) continue; // skip malformed

        const remaining = entry.expiry - now;
        if (remaining <= 0) continue;

        userCache[command] = entry.expiry;
        cooldownCache.set(user.userId, userCache); // armTimer reads this
        setAuthority(user.userId, command, AUTHORITY.table); // unknown provenance
        restored++;

        // Resolve the channel lazily so one dead channel can't stall startup.
        const lazyChannel = {
          id: entry.channelId,
          send: async (content) => {
            const channel = await client.channels.fetch(entry.channelId);
            return channel.send(content);
          },
        };
        armTimer(user.userId, command, entry.expiry, lazyChannel);
      }

      if (Object.keys(userCache).length > 0) cooldownCache.set(user.userId, userCache);

      // Reminder mutes live alongside the cooldowns
      const muted = Object.entries(user.disabled ?? {})
        .filter(([, off]) => off === true)
        .map(([cmd]) => cmd);
      if (muted.length) mutedCommands.set(user.userId, new Set(muted));
    }

    console.log(`[startup] Restored ${restored} cooldown(s) for ${users.length} user(s).`);

    await dailies.restoreNudges(
      async (channelId) => {
        if (!channelId) return null;
        try { return await client.channels.fetch(channelId); }
        catch { return null; }
      },
      (userId) => isReminderPaused(userId) || isMuted(userId, 'dailies')
    );
  } catch (err) {
    console.error('[startup] Failed to restore cooldowns:', err);
  }
};

// ─── Module export ────────────────────────────────────────────────────────────

module.exports = {
  name: "messageCreate",
  once: false,
  async execute(message, client) {
    try {
      if (message.author.id === NARUTO_BOT_ID) {
        await handleBotMessage(message, client);
      } else if (!message.author.bot) {
        await handleUserMessage(message, client);
      }
    } catch (err) {
      // Top-level catch — one bad message should never crash the bot
      console.error(`[messageCreate] Unhandled error: ${err.message}`, err);
    }
  },
  restoreCooldownsFromDB,
  // Wrapped, not passed directly: handleBotMessage is a `const` declared below
  // this object, so referencing it here would hit the temporal dead zone.
  handleBotMessage: (...args) => handleBotMessage(...args),
};

// ─── Bot message router ───────────────────────────────────────────────────────

const handleBotMessage = async (message, client) => {
  const embed = message.embeds[0];
  const title = embed?.title?.toLowerCase() ?? "";
  const text  = messageText(message);

  // Record XP from every page before routing — training, report results and the
  // team page all carry numbers worth keeping, whatever else we do with them.
  const owner  = extractOwner(text);
  const ownerId = owner ? resolveUserId(client, owner) : null;

  // ── Report riddle: remember the info, answer when the options appear ──────
  if (reports.P.stageInfo.test(text)) {
    const info = reports.parseInfo(text);
    if (info) {
      reportRiddles.set(message.id, { info, at: Date.now(), answered: false });
      trace('report info', { user: owner, ...info });
    } else {
      trace('report info unparsed', { preview: text.replace(/\s+/g, ' ').slice(0, 120) });
    }
  } else if (reports.P.stageWriting.test(text)) {
    const riddle = reportRiddles.get(message.id);
    if (riddle && !riddle.answered) {
      riddle.answered = true;
      const options = reports.parseOptions(text);
      const line = ownerId ? reports.format(ownerId, riddle.info, options) : null;
      if (line) {
        await safeSend(message.channel, line);
        trace('report answered', { user: owner, options: options.length });
      } else {
        trace('report unanswerable', { user: owner, options: options.length });
      }
    }
  } else if (reports.P.stageResult.test(text)) {
    reportRiddles.delete(message.id);
  }
  if (ownerId) {
    const noted = await xptracker.observe(message, text, ownerId);
    if (noted) trace('xp', { user: owner, noted });

    // Dailies progress + pre-reset nudge
    const daily = dailies.parse(text);
    if (daily) {
      await dailies.record(ownerId, message.channel.id, daily);
      dailies.scheduleNudge(
        ownerId, daily,
        (t) => safeSend(message.channel, t),
        () => isReminderPaused(ownerId) || isMuted(ownerId, 'dailies')
      );
      trace('dailies', { user: owner, open: dailies.remaining(daily).length });
    }

    // Balance snapshot, for "what can I afford"
    const balance = econ.parseBalance(text);
    if (balance) {
      await econ.record(ownerId, balance);
      trace('balance', { user: owner, ryo: balance.ryo });
    }
  } else if (owner) {
    trace('observe skipped — unknown user', { owner });
  }

  // The V2 migration is PARTIAL. As of Aug 2026: mission/report/daily/weekly/
  // train send Components V2, while `n cd`, `n t` and `n bal` still send classic
  // embeds. Both shapes have to keep working — messageText() reads either.

  // The `n cd` page is authoritative — it carries real remaining times, so it
  // gets parsed directly rather than being matched against an armed intent.
  if (title.includes("cooldowns") || /'s cooldowns\b/i.test(text)) {
    if (embed) await processCooldownEmbed(message, client);
    else       console.warn('[cooldowns] cooldown page had no embed — V2 parser needed');
    return;
  }
  // Team page: footer is "eiota's ninjas -- 1/4 (id:223)"
  if (embed?.footer?.text?.includes("id:") || /\(id:\d+\)/i.test(text)) {
    await processTeamEmbed(message, client);
    return;
  }

  // Confirm/discard anything the user just typed. Not an early return —
  // a rejection ("still on cooldown") is also input for the processors below,
  // and saveCooldown is idempotent so a double-arm is a no-op.
  await resolvePendingCommands(message, client);

  if (message.embeds.length === 0) {
    const c = message.content.toLowerCase();
    if (c.includes("defeated an enemy team")) {
      await processTowerMessage(message, client);
    } else if (c.includes("challenged you to a fight") || c.includes("defeated")) {
      await processSparringMessage(message, client);
    } else if (c.includes("was purchased by") && (c.includes("v15") || c.includes("v20"))) {
      await processVoteShopPurchase(message, client);
    } else if (c.includes("still on cooldown") && (c.includes("v15") || c.includes("v20"))) {
      await processVoteShopCooldown(message, client);
    }
  }
};

// ─── User message router ──────────────────────────────────────────────────────

const handleUserMessage = async (message, client) => {
  rememberUser(message.author); // so the game bot's "eiota's …" resolves to an id

  // ── nh <command> dispatcher ───────────────────────────────────────────────
  if (message.content.startsWith('nh ')) {
    const args        = message.content.slice(3).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    const command     = client.commands.get(commandName);

    if (command) {
      try {
        await command.execute(message, args);
      } catch (error) {
        console.error('[commands] Error executing command:', error);
        if (!message.replied) {
          await message.reply('There was an error executing that command.');
        }
      }
      return; // don't fall through to cooldown logic
    }
  }

  const lower  = message.content.trim().toLowerCase();
  const userId = message.author.id;

  // ── nh track xp <id> ─────────────────────────────────────────────────────
  const trackMatch = lower.match(/^nh\s+track\s+xp\s+(\d+)/);
  if (trackMatch) {
    const unitId = trackMatch[1];
    const key    = `${userId}:${unitId}`;
    if (xpSessions.has(key)) {
      await safeSend(message.channel,
        `<@${userId}> already tracking unit **${unitId}**. End it first with \`nh end track xp ${unitId}\`.`
      );
    } else {
      xpSessions.set(key, {
        startXp: null, timestamp: Date.now(),
        channelId: message.channel.id, pending: true,
      });
      await safeSend(message.channel,
        `<@${userId}> XP tracking armed for unit **${unitId}** — use \`n t\` to lock in the starting XP.`
      );
    }
    return;
  }

  // ── nh end track xp <id> ─────────────────────────────────────────────────
  const endMatch = lower.match(/^nh\s+end\s+track\s+xp\s+(\d+)/);
  if (endMatch) {
    const unitId  = endMatch[1];
    const session = xpSessions.get(`${userId}:${unitId}`);
    if (!session || session.startXp === null) {
      await safeSend(message.channel,
        `<@${userId}> no active session for unit **${unitId}**. Start one with \`nh track xp ${unitId}\`.`
      );
    } else {
      session.pendingEnd   = true;
      session.endChannelId = message.channel.id;
      await safeSend(message.channel,
        `<@${userId}> got it — use \`n t\` to capture final XP for unit **${unitId}**.`
      );
    }
    return;
  }

  // ── nh feed … — daily feed routine ───────────────────────────────────────
  // Uses raw content, not `lower`: multi-line pastes and casing must survive.
  const feedMatch = message.content.trim().match(/^nh\s+feed(?:\s+help)?\b([\s\S]*)$/i);
  if (feedMatch) {
    try {
      await safeSend(message.channel, await feed.command(userId, feedMatch[1]));
    } catch (err) {
      console.error('[feed] command failed:', err);
      await safeSend(message.channel, `<@${userId}> couldn't reach the feed routine right now.`);
    }
    return;
  }

  // ── nh dailies — progress toward today's set ─────────────────────────────
  if (/^nh\s+(dailies|daily|d)$/.test(lower)) {
    await safeSend(message.channel, await dailies.report(userId).catch(() =>
      `<@${userId}> couldn't read dailies data right now.`));
    return;
  }

  // ── nh ryo / nh econ — earnings, spend, and what the balance buys ────────
  if (/^nh\s+(ryo|econ|economy|money)$/.test(lower)) {
    await safeSend(message.channel, await econ.report(userId).catch(() =>
      `<@${userId}> couldn't read economy data right now.`));
    return;
  }

  // ── nh on/off <command> — mute individual reminders ──────────────────────
  const muteMatch = lower.match(/^nh\s+(on|off)\s+(\w+)$/);
  if (muteMatch) {
    const [, verb, target] = muteMatch;
    const known = new Set([...Object.keys(COOLDOWN_DURATIONS), 'daily', 'dailies', 'all']);
    if (!known.has(target)) {
      await safeSend(message.channel,
        `<@${userId}> unknown reminder **${target}**. Options: ${[...known].join(', ')}`);
      return;
    }
    await setMuted(userId, target, verb === 'off');
    await safeSend(message.channel,
      verb === 'off'
        ? `<@${userId}> 🔕 **${target}** reminders muted. \`nh on ${target}\` to undo.`
        : `<@${userId}> 🔔 **${target}** reminders back on.`);
    return;
  }

  // ── nh mutes — what's currently silenced ─────────────────────────────────
  if (/^nh\s+(mutes|toggles)$/.test(lower)) {
    const set = mutedCommands.get(userId);
    await safeSend(message.channel,
      set?.size
        ? `<@${userId}> muted: ${[...set].map(c => `**${c}**`).join(', ')}`
        : `<@${userId}> nothing muted — all reminders are on.`);
    return;
  }

  // ── nh xp [name|id] — gains today, rate, and level-up ETA ────────────────
  const xpMatch = lower.match(/^nh\s+xp(?:\s+(.+))?$/);
  if (xpMatch) {
    try {
      await safeSend(message.channel, await xptracker.report(userId, xpMatch[1]?.trim() || null));
    } catch (err) {
      console.error('[xp] report failed:', err);
      await safeSend(message.channel, `<@${userId}> couldn't read XP data right now.`);
    }
    return;
  }

  // ── nh status — show current cooldown timers ──────────────────────────────
  if (lower === 'nh status') {
    const now       = Math.floor(Date.now() / 1000);
    const userCache = cooldownCache.get(userId);
    const resetLine = `\n🔄  Dailies reset <t:${nextDailyResetUnix()}:R> (00:00 UTC / 05:30 IST)`;

    if (!userCache || Object.keys(userCache).length === 0) {
      await safeSend(message.channel, `<@${userId}> no active cooldowns tracked.${resetLine}`);
      return;
    }

    const lines = Object.entries(userCache)
      .sort(([, a], [, b]) => a - b) // soonest first
      .map(([cmd, expiry]) => {
        const rem = expiry - now;
        return rem <= 0
          ? `✅  **${cmd}** — ready now`
          : `⏳  **${cmd}** — ${formatDuration(rem)}`;
      });

    const pauseLine = isReminderPaused(userId)
      ? `\n⏸  Reminders paused until <t:${pausedUntil.get(userId)}:T>`
      : '';

    await safeSend(message.channel,
      `<@${userId}> **cooldown status:**\n${lines.join('\n')}${resetLine}${pauseLine}`
    );
    return;
  }

  // ── nh pause <Xh|Xm> ─────────────────────────────────────────────────────
  const pauseMatch = lower.match(/^nh\s+pause\s+(\d+)(h|m)$/);
  if (pauseMatch) {
    const amount  = parseInt(pauseMatch[1]);
    const seconds = pauseMatch[2] === 'h' ? amount * 3600 : amount * 60;
    pauseReminders(userId, seconds);
    await safeSend(message.channel,
      `<@${userId}> reminders paused for **${amount}${pauseMatch[2]}**. Use \`nh resume\` to unpause early.`
    );
    return;
  }

  // ── nh resume ────────────────────────────────────────────────────────────
  if (lower === 'nh resume') {
    resumeReminders(userId);
    await safeSend(message.channel, `<@${userId}> reminders resumed.`);
    return;
  }

  // ── n cd — suppress the upcoming burst from the cooldown embed ───────────
  if (lower === 'n cd') {
    cdCheckSuppressed.add(userId);
    setTimeout(() => cdCheckSuppressed.delete(userId), 5000).unref();
    return;
  }

  // ── n feed <id> <item> — tick the routine off as you go ──────────────────
  const fedMatch = lower.match(/^n\s+feed\s+(\d+)\s+(\S+)/);
  if (fedMatch) {
    await feed.logFeed(userId, fedMatch[1], fedMatch[2], message.id);
    trace('feed logged', { user: message.author.username, unit: fedMatch[1], item: fedMatch[2] });
    return;
  }

  // ── n ch — record challenger for fight outcome tracking ──────────────────
  if (lower.startsWith('n ch')) {
    pendingChallenges.set(message.channel.id, { challengerId: userId, timestamp: Date.now() });
    return;
  }

  // ── Cooldown-triggering commands — armed, not committed ──────────────────
  // Nothing is registered here. The cooldown is only saved once the game bot
  // confirms the command ran (see resolvePendingCommands).
  for (const [pattern, command] of COMMAND_PATTERNS) {
    if (pattern.test(lower)) {
      armPending(message, command);
      return;
    }
  }
};

// ─── Processors ──────────────────────────────────────────────────────────────

const processCooldownEmbed = async (message, client) => {
  const embed    = message.embeds[0];
  const username = embed.title.split("'s")[0];
  const user     = findUserByUsername(client, username);

  if (!user) {
    await safeSend(message.channel, `User **${username}** not found in cache.`);
    return;
  }

  // Check if this was triggered by "n cd" — if so, save cooldowns silently
  const isSilent = cdCheckSuppressed.has(user.id);
  if (isSilent) cdCheckSuppressed.delete(user.id);

  let anyUpdated = false;
  for (const field of embed.fields) {
    for (const line of field.value.split('\n')) {
      const { command, cooldownTime } = parseCooldownLine(line);
      if (!command || cooldownTime === undefined) continue;
      if (['vote', 'booster'].includes(command)) continue;
      if (RETIRED_COMMANDS.has(command)) continue;

      // `n cd` reports real remaining times — the most reliable source we have,
      // and the way to resync anything that drifted.
      const updated = await saveCooldown(user.id, command, cooldownTime, message.channel, client,
        { authority: AUTHORITY.stated });
      if (updated) anyUpdated = true;
    }
  }

  // Only confirm if it wasn't a manual cd check
  if (anyUpdated && !isSilent) {
    await safeSend(message.channel, `<@${user.id}> reminders added for your cooldowns.`);
  }
};

const parseCooldownLine = (line) => {
  const withTime    = line.match(/---\s+(\w+)\s*\(([^)]+)\)/i);
  const withoutTime = line.match(/:white_check_mark:\s+---\s+(\w+)/i);
  if (withTime)    return { command: normalizeCommand(withTime[1]),    cooldownTime: parseTimeString(withTime[2]) };
  if (withoutTime) return { command: normalizeCommand(withoutTime[1]), cooldownTime: 0 };
  return {};
};

const processTowerMessage = async (message, client) => {
  const match = message.content.match(/\*\*(\w+)\*\* defeated an enemy team/i);
  if (!match) return;
  const user = findUserByUsername(client, match[1]);
  if (!user) return;
  const updated = await saveCooldown(user.id, "tower", COOLDOWN_DURATIONS.tower, message.channel, client);
  if (updated) await safeSend(message.channel, `6h tower reminder set.`);
};

const processSparringMessage = async (message, client) => {
  const challengeMatch = message.content.match(/\*\*(.*?)\*\* challenged you to a fight \*\*(.*?)\*\*!/i);
  if (challengeMatch) {
    const pending = pendingChallenges.get(message.channel.id);
    if (pending && Date.now() - pending.timestamp < PENDING_TTL_MS) {
      recentChallenges.set(message.channel.id, { challengerId: pending.challengerId, timestamp: Date.now() });
      pendingChallenges.delete(message.channel.id);
    }
    return;
  }

  if (message.content.includes('defeated')) {
    const last = recentChallenges.get(message.channel.id);
    if (last && Date.now() - last.timestamp < PENDING_TTL_MS) {
      const updated = await saveCooldown(last.challengerId, "challenge", COOLDOWN_DURATIONS.challenge, message.channel, client);
      // no ping — just a quiet confirmation
      if (updated) await safeSend(message.channel, `✅ Challenge reminder set.`);
      recentChallenges.delete(message.channel.id);
    }
  }
};

const processVoteShopPurchase = async (message, client) => {
  const itemMatch = message.content.match(/offer with code `(v\d+)`/i);
  const userMatch = message.content.match(/was purchased by \*\*([^*]+)\*\*/i);
  if (!itemMatch || !userMatch) return;

  const rawName  = userMatch[1].replace(/^[_.\s]+|[_.\s]+$/g, '');
  const user     = findUserByUsername(client, rawName);
  if (!user) return;

  const key      = `buy_${itemMatch[1].toLowerCase()}`;
  const duration = COOLDOWN_DURATIONS[key];
  if (!duration) return;

  // This duration is a hardcoded guess — the purchase message states no time.
  // Marked as such so `n cd` or a later "still on cooldown" reply can correct it.
  const updated = await saveCooldown(user.id, key, duration, message.channel, client,
    { authority: AUTHORITY.table });
  if (updated) {
    await safeSend(message.channel,
      `YaY ~${duration / 3600}h reminder set for **${itemMatch[1]}** vote shop cooldown.\n` +
      `-# estimated — run \`n cd\` any time to correct it`
    );
  }
};

const processVoteShopCooldown = async (message, client) => {
  const itemMatch = message.content.match(/offer\s*\(`(v\d+)`\)/i);
  const userMatch = message.content.match(/cooldown\s+\*\*([^*]+)\*\*!?/i);
  const timeMatch = message.content.match(/<t:(\d+)(?::\w)?>/i);
  if (!itemMatch || !userMatch || !timeMatch) return;

  // strip Discord formatting chars from username: _kazuto._ → kazuto.
  const rawName = userMatch[1].replace(/^[_.\s]+|[_.\s]+$/g, '');
  const user    = findUserByUsername(client, rawName);
  if (!user) return;

  const key = `buy_${itemMatch[1].toLowerCase()}`;
  const remainingSeconds = parseInt(timeMatch[1]) - Math.floor(Date.now() / 1000);

  // The game sometimes reports a "purchasable again" time that is already in the
  // past while still refusing the purchase. Giving up here left the user with an
  // expired reminder and no follow-up, so re-check instead of going silent.
  if (remainingSeconds <= 0) {
    const RECHECK = 3600;
    const armed = await saveCooldown(user.id, key, RECHECK, message.channel, client,
      { authority: AUTHORITY.stated });
    console.warn(`[voteshop] ${key} refused for ${user.id} but stated time is ` +
                 `${-remainingSeconds}s in the past — re-checking in ${RECHECK}s`);
    if (armed) {
      await safeSend(message.channel,
        `<@${user.id}> **${itemMatch[1]}** is still on cooldown even though the bot says ` +
        `<t:${timeMatch[1]}:R>. I'll remind you again in 1h — \`n cd\` for the real timer.`
      );
    }
    return;
  }

  const updated = await saveCooldown(user.id, key, remainingSeconds, message.channel, client,
    { authority: AUTHORITY.stated });

  if (updated) {
    await safeSend(message.channel,
      `Yay reminder set for **${itemMatch[1]}** — <t:${timeMatch[1]}:R>.`
    );
  }
};

const processTeamEmbed = async (message, client) => {
  // Skip the expensive history fetch if nobody has an active session
  if (xpSessions.size === 0) return;

  // Was embed-footer only; V2 pages have no footer, so read the whole message.
  const text    = messageText(message);
  const idMatch = text.match(/id:(\d+)/i);
  const xpMatch = text.match(/([\d,]+)\/[\d,]+\s*XP/i);
  if (!idMatch || !xpMatch) return;

  const unitId    = idMatch[1];
  const currentXp = parseInt(xpMatch[1].replace(/,/g, ''), 10);

  const recent = await message.channel.messages.fetch({ limit: 6 });
  let userId = null;
  for (const [, msg] of recent) {
    if (!msg.author.bot && msg.content.trim().toLowerCase() === 'n t' && msg.id !== message.id) {
      userId = msg.author.id;
      break;
    }
  }
  if (!userId) return;

  const key     = `${userId}:${unitId}`;
  const session = xpSessions.get(key);
  if (!session) return;

  // Lock in starting XP
  if (session.pending) {
    session.startXp = currentXp;
    session.pending = false;
    await safeSend(message.channel,
      `<@${userId}> XP tracking started for unit **${unitId}** at **${currentXp.toLocaleString()} XP**.`
    );
    return;
  }

  // Deliver final report with XP/hr
  if (session.pendingEnd) {
    const gained   = currentXp - session.startXp;
    const elapsed  = Math.round((Date.now() - session.timestamp) / 1000);
    const xpPerHr  = elapsed > 0 ? Math.round((gained / elapsed) * 3600) : 0;
    xpSessions.delete(key);

    const target = client.channels.cache.get(session.endChannelId) ?? message.channel;
    await safeSend(target,
      `<@${userId}> XP report for unit **${unitId}**:\n` +
      `> Start:  **${session.startXp.toLocaleString()} XP**\n` +
      `> End:    **${currentXp.toLocaleString()} XP**\n` +
      `> Gained: **+${gained.toLocaleString()} XP** over ${formatDuration(elapsed)}\n` +
      `> Rate:   **~${xpPerHr.toLocaleString()} XP/hr**`
    );
  }
};
