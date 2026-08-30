const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const database = require("../models/user");
const { trace } = require("../debug");
const xptracker = require("../xptracker");
const dailies   = require("../dailies");
const econ      = require("../econ");
const feed      = require("../feed");
const reports   = require("../reports");
const quiet     = require("../quiet");
const digest    = require("../digest");
const monthly   = require("../pass");
const jutsu     = require("../jutsu");
const invasion  = require("../invasion");

// ─── Constants ───────────────────────────────────────────────────────────────

const {
  GAME_BOT_ID: NARUTO_BOT_ID, REPORT_ANSWER_CHANNELS,
} = require('../config');
const { Setting } = require('../models/tracking');

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

// Cooldowns deliberately not persisted. This used to hold mission and report to
// save DB writes, but a restart then lost them outright while every other
// cooldown came back. An upsert a minute is cheap; a dropped reminder is not.
const MEMORY_ONLY = new Set();

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

// `${userId}:${command}` → the channel that cooldown was armed in, so the ping
// lands where the command was actually run.
const cooldownChannels = new Map();
const ckey = (userId, command) => `${userId}:${command}`;

// ─── Report-answer whitelist ──────────────────────────────────────────────────
// Channels allowed to see which option to click. Seeded from
// REPORT_ANSWER_CHANNELS, then owned at runtime so an admin can change it from
// Discord without a redeploy. Persisted so a restart doesn't quietly re-open or
// re-close channels.
const REPORT_SETTING_KEY = 'reportAnswerChannels';
const reportChannels = new Set(REPORT_ANSWER_CHANNELS);

const mayShowReportOption = (channelId) => reportChannels.has(channelId);

const loadReportChannels = async () => {
  try {
    const row = await Setting.findOne({ key: REPORT_SETTING_KEY }).lean();
    if (Array.isArray(row?.value)) {
      for (const id of row.value) reportChannels.add(id);
    }
  } catch (err) {
    console.error(`[settings] Could not load report whitelist: ${err.message}`);
  }
  return reportChannels.size;
};

const saveReportChannels = async () => {
  try {
    await Setting.updateOne(
      { key: REPORT_SETTING_KEY },
      { $set: { value: [...reportChannels], at: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error(`[settings] Could not save report whitelist: ${err.message}`);
  }
};

// Who may change it: the bot owner, or anyone who can manage the server.
const canManageChannels = (message) => {
  if (process.env.OWNER_ID && message.author.id === process.env.OWNER_ID) return true;
  try {
    const p = message.member?.permissions;
    return Boolean(p?.has?.('Administrator') || p?.has?.('ManageGuild') || p?.has?.('ManageChannels'));
  } catch { return false; }
};

// userId → when we last saw them actually do something, so a reminder that goes
// unheeded can tell "was around and skipped it" from "had logged off".
const lastActivityAt = new Map();

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
// ─── Per-user timezone ────────────────────────────────────────────────────────
// Every window the helper understands — quiet hours, `nh pause train 16:00-05:30`
// — is a wall-clock time, which means nothing without a zone. It used to assume
// IST for everybody. That is right for most of this server and silently wrong
// for everyone else, whose mute windows landed hours off.
//
// So each account carries its own, set once with `nh tz`. Prefer an IANA name
// over a fixed offset: it follows daylight saving by itself.
const userTz = new Map();   // userId → minutes offset, or an IANA zone string

const tzFor = (userId) => userTz.get(userId) ?? quiet.DEFAULT_TZ_MINUTES;

const persistTz = (userId, tz) =>
  database.collection.findOneAndUpdate(
    { userId }, { $set: { tz } }, { upsert: true }
  ).catch(err => console.error(`[db] tz write failed for ${userId}: ${err.message}`));

/**
 * The timezone picker.
 *
 * Typing "Europe/Berlin" assumes you know your zone's name; most people do not.
 * Everyone does know what time it is where they are, so each row leads with that
 * zone's current clock and you pick the one matching your watch. Typing still
 * works for anyone who prefers it.
 */
const buildTzPicker = (userId) => {
  const current = userTz.get(userId);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`tz:${userId}`)          // the id is the lock — see handleComponent
    .setPlaceholder('Pick the row showing your current time')
    .addOptions(quiet.zoneChoices().map(({ zone, where, clock, offset }) => {
      const sign = offset < 0 ? '-' : '+';
      const a = Math.abs(offset);
      return {
        label: `${clock} — ${where}`.slice(0, 100),
        description: `${zone} · UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`.slice(0, 100),
        value: zone,
        default: current === zone,
      };
    }));
  return new ActionRowBuilder().addComponents(menu);
};

/** Store a timezone and re-anchor anything already expressed in wall-clock time. */
const applyTimezone = async (userId, tz) => {
  userTz.set(userId, tz);
  await persistTz(userId, tz);

  // Existing windows were stored against the old zone; move them across so the
  // times someone typed keep meaning what they meant.
  const cfg = quiet.getConfig(userId);
  if (cfg) {
    const moved = { ...cfg, tz };
    quiet.setConfig(userId, moved);
    await persistQuiet(userId, moved);
  }
  return cfg;
};

// Channel ids where someone just typed `n cd`, so the resulting page is silent.
const cdCheckSuppressed = new Set();

// message id → when we first announced it. Edits of the same cooldown page must
// not produce a second "reminders added". Swept hourly; entries are tiny.
const cdAnnounced = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, at] of cdAnnounced) if (at < cutoff) cdAnnounced.delete(id);
}, 30 * 60 * 1000).unref();

// `${userId}:${unitId}` → { startXp, timestamp, pending, pendingEnd, endChannelId }
const xpSessions = new Map();

// messageId → { info, at, answered } for an in-flight `n r`.
// The info page and the options are edits of the same message, so the id ties
// the two halves together.
const reportRiddles = new Map();

// channelId → the most recent `n feed`, so the game's reply can be paired with it
const recentFeeds = new Map();

// userId → unixSeconds when pause expires
const pausedUntil = new Map();

// userId → Map<command, rule>, where "all" covers everything. A rule is one of:
//
//   true                        muted indefinitely      nh off train
//   { until: unixSeconds }      muted for a while       nh pause train 2h
//   { startMin, endMin, tz }    muted daily in a window nh pause train 16:00-05:30
//   { auto: true }              the bot gave up on its own — see deliverReminder
//
// Backed by user.disabled in Mongo. The old shape was a plain map of
// command → true, which still reads correctly as the first form.
const mutedCommands = new Map();

// "report" is the 10-minute reminder; "answers" is the report *helper*. Keeping
// them distinct means muting one can never silently kill the other.
const MUTE_ALIASES = { reporthelper: 'answers', answer: 'answers', helper: 'answers' };

// Everything that can be silenced. Built once so `nh off`, `nh pause <cmd>` and
// the error messages can never drift apart.
const MUTABLE = new Set([
  ...Object.keys(COOLDOWN_DURATIONS), 'daily', 'dailies', 'digest', 'answers', 'jutsu',
  'invasion', 'all',
]);

const ruleActive = (rule) => {
  if (!rule) return false;
  if (rule === true) return true;
  if (rule.auto) return true;
  if (rule.until) return rule.until > Math.floor(Date.now() / 1000);
  if (rule.startMin != null) return quiet.withinWindow(rule);
  return false;
};

const isMuted = (userId, command) => {
  const rules = mutedCommands.get(userId);
  if (!rules) return false;
  return ruleActive(rules.get('all')) || ruleActive(rules.get(command));
};

const describeRule = (rule) => {
  if (rule === true) return 'off';
  if (rule?.auto) return 'resting — you weren\'t using it';
  if (rule?.until) return `until <t:${rule.until}:t>`;
  if (rule?.startMin != null) return `daily ${quiet.describeWindow(rule)}`;
  return 'off';
};

const persistMutes = (userId, rules) => {
  const doc = {};
  for (const [cmd, rule] of rules) doc[cmd] = rule;
  database.collection.findOneAndUpdate(
    { userId },
    { $set: { disabled: doc } },
    { upsert: true }
  ).catch(err => console.error(`[db] mute write failed for ${userId}: ${err.message}`));
};

const setMuted = async (userId, command, rule) => {
  const rules = mutedCommands.get(userId) ?? new Map();
  if (rule) rules.set(command, rule); else rules.delete(command);
  if (command === 'all' && !rule) rules.clear();   // "on all" clears everything
  mutedCommands.set(userId, rules);
  persistMutes(userId, rules);
};

// ─── Listening back ───────────────────────────────────────────────────────────
// Not everyone is grinding. Plenty of players open the game, run their daily,
// and leave — and the helper used to keep pinging them for every cooldown they
// ever armed, which is noise to someone who was never coming back that session.
//
// Nobody should have to read the docs to escape that, so the bot works it out.
// Each reminder is judged by what the player does next: run the command soon
// after and the reminder did its job; run it hours later, or never, and it did
// not. Three unheeded reminders in a row for one command and that command rests
// — with a note saying so and how to undo it.
//
// It heals on its own too. Come back and actually grind something and its
// reminders return without anyone typing a command.
const IGNORE_LIMIT     = 3;               // unheeded reminders before resting
const GRIND_RUNS       = 3;               // runs inside the window = back to it
const GRIND_WINDOW_MS  = 60 * 60 * 1000;

/**
 * How soon after a reminder a run still counts as "that ping worked".
 *
 * One fixed window cannot serve a 60-second mission and a 20-hour daily. Half a
 * minute is nothing to a mission grinder, while someone who gets their daily
 * ping at 4pm and does it after dinner was plainly reminded — judging that on a
 * 45-minute clock would rest the one reminder casual players actually want.
 * So the window is half the command's own cooldown, floored and capped.
 */
const ackWindowMs = (command) => {
  const seconds = durationFor(command);
  const half    = Number.isFinite(seconds) ? (seconds * 1000) / 2 : 0;
  return Math.min(Math.max(half, 45 * 60 * 1000), 12 * 60 * 60 * 1000);
};

const remindedAt    = new Map();  // ckey → ms the outstanding reminder went out
const ignoredStreak = new Map();  // ckey → consecutive reminders not acted on
const recentRuns    = new Map();  // ckey → recent run timestamps

// Reminder counters — stats.reminders existed in the schema but was never
// incremented, so /stats always showed zeros.
const bumpStat = (userId, command) => {
  database.collection.findOneAndUpdate(
    { userId },
    { $inc: { [`stats.reminders.${command}`]: 1 } },
    { upsert: true }
  ).catch(err => console.error(`[db] stat bump failed for ${userId}: ${err.message}`));
};

/**
 * Called when the game bot confirms a command actually ran. Settles whatever
 * reminder was outstanding for it, and notices a player picking a command back
 * up so a rested reminder can wake itself.
 */
const noteCommandRun = (userId, command) => {
  const key = ckey(userId, command);
  const now = Date.now();

  const sentAt = remindedAt.get(key);
  if (sentAt !== undefined) {
    remindedAt.delete(key);
    // Read before the caller stamps this run, so it means "the last thing they
    // did *before* now".
    const previously = lastActivityAt.get(userId) ?? 0;

    if (now - sentAt <= ackWindowMs(command)) {
      ignoredStreak.delete(key);            // the ping did its job
    } else if (previously > sentAt) {
      // They were around after the ping, doing other things, and still left this
      // one. That is a choice about this command.
      ignoredStreak.set(key, (ignoredStreak.get(key) ?? 0) + 1);
    }
    // Otherwise they simply logged off. That says nothing about whether they
    // want the reminder, so it is not held against them.
  }

  const runs = (recentRuns.get(key) ?? []).filter((t) => now - t < GRIND_WINDOW_MS);
  runs.push(now);
  recentRuns.set(key, runs);

  // Playing it properly again — undo a rest the bot decided on, but never one
  // the player set themselves.
  if (runs.length >= GRIND_RUNS && mutedCommands.get(userId)?.get(command)?.auto) {
    setMuted(userId, command, null);
    ignoredStreak.delete(key);
    console.log(`[reminders] ${command} for ${userId} woken — back in use`);
  }
};

/**
 * The single place a "your X is ready" ping leaves the bot.
 */
const deliverReminder = async (userId, command, channel) => {
  if (isReminderPaused(userId) || isMuted(userId, command)) return;

  const key = ckey(userId, command);
  let note  = '';

  if ((ignoredStreak.get(key) ?? 0) >= IGNORE_LIMIT) {
    await setMuted(userId, command, { auto: true });
    ignoredStreak.delete(key);
    recentRuns.delete(key);
    console.log(`[reminders] ${command} for ${userId} resting — ${IGNORE_LIMIT} unheeded`);
    note = `\n-# last one — you haven't been using these. \`nh on ${command}\` brings them back.`;
  }

  bumpStat(userId, command);
  // A watchdog re-send is the same reminder, so it must not reset the clock the
  // acknowledgement is measured against.
  if (!remindedAt.has(key)) remindedAt.set(key, Date.now());

  // Held for quiet hours rather than delivered. The held queue is memory only,
  // so this must stay unmarked: a restart should backfill it and hold it again,
  // not treat it as already said.
  if (quiet.deferReminder(userId, command, channel)) return;

  await safeSend(channel, `<@${userId}> your **${command}** is ready!${note}`);

  // `remindedAt` is memory only, so a restart forgets what has already been
  // announced and the ready-backfill says it all over again. Writing the mark
  // next to the cooldown lets the next boot tell "I was down when this expired"
  // from "I already told them".
  markNotified(userId, command);
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
  for (const [k, v] of recentFeeds)
    if (now - v.at > PENDING_TTL_MS) recentFeeds.delete(k);
  for (const [channelId, list] of pendingCommands) {
    const kept = list.filter(p => now - p.timestamp <= CONFIRM_WINDOW_MS);
    if (kept.length) pendingCommands.set(channelId, kept);
    else pendingCommands.delete(channelId);
  }
  // Reminder bookkeeping. An outstanding reminder is kept for a week: someone
  // who wanders back on day three still gets that ping scored honestly.
  for (const [k, v] of remindedAt)
    if (now - v > 7 * 24 * 60 * 60 * 1000) remindedAt.delete(k);
  for (const [k, list] of recentRuns) {
    const kept = list.filter(t => now - t < GRIND_WINDOW_MS);
    if (kept.length) recentRuns.set(k, kept);
    else recentRuns.delete(k);
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

// Retries are only safe if the operation is idempotent, and sending a message is
// not. A connect timeout means the *response* was lost, not necessarily the
// request: Discord may well have created the message already. Retrying blind is
// how one player got "your train is ready!" twice in the same second.
//
// Discord solves this properly. A message carrying a nonce with enforce_nonce
// set is deduplicated server-side — a retry with the same nonce returns the
// message that already exists instead of posting a second copy. So the nonce is
// generated once per logical send and reused across every attempt.
//
// Nonces are capped at 25 characters, hence base36.
let nonceSeq = 0;
const nextNonce = () =>
  `${Date.now().toString(36)}-${(nonceSeq = (nonceSeq + 1) % 1_000_000).toString(36)}`;

// Never throws — silently logs if channel is deleted/inaccessible
const safeSend = (channel, content) => {
  const payload = typeof content === 'string' ? { content } : { ...content };
  payload.nonce = nextNonce();
  payload.enforceNonce = true;
  return retry(() => channel.send(payload)).catch(err =>
    console.error(`[safeSend] channel ${channel.id}: ${err.message}`)
  );
};

// username → userId for everyone we've seen speak. The game bot names people in
// its page headers but never mentions them, and client.users.cache is unreliable,
// so this is the dependable way to turn "eiota" back into an id.
const knownUsers = new Map();

const rememberUser = (user) => {
  if (user?.username) knownUsers.set(user.username.toLowerCase(), user.id);
};

/**
 * Resolve a name the game bot printed back to a Discord user.
 *
 * Names arrive wrapped in markdown ("**_kazuto._**"), but a trailing dot is also
 * a legitimate part of a Discord username — "slimysludge.", "mxrxsxki." — so
 * stripping punctuation up front loses real matches. Try the name exactly as
 * given first, and only then progressively looser forms.
 */
const findUserByUsername = (client, username) => {
  const raw = String(username ?? '').trim().toLowerCase();
  if (!raw) return null;

  const variants = [
    raw,
    raw.replace(/^[*_~`]+|[*_~`]+$/g, ''),   // markdown only
    raw.replace(/^[_.\s]+|[_.\s]+$/g, ''),   // legacy: also trims dots
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  for (const v of variants) {
    const id = knownUsers.get(v);
    if (id) return { id, username: v };
  }
  for (const v of variants) {
    const hit = client.users.cache.find(u => u.username.toLowerCase() === v);
    if (hit) return hit;
  }
  return null;
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
  // Two different clocks live on the dailies page and they do not coincide:
  //   "Resets <t:…>"                        — when the *tasks* roll over (00:00 UTC)
  //   "Claim your Daily reward in 4h 3m"    — when the *ryo reward* can be claimed
  // The reminder is about claiming, so the button wins. Seen live: `n cd` said
  // Daily 4h 7m while the same page said it resets in 6h.
  daily: (text) => {
    const claim = text.match(/claim your daily reward in\s+([0-9dhms\s]+)/i);
    if (claim) return parseTimeString(claim[1].trim());
    // No "in …" on the button means it is claimable right now.
    if (/claim your daily reward\b/i.test(text)) return 0;
    return null;
  },
  // "🎁 Your next weekly reward is in **6d 23h 54m 21s**."
  weekly: (text) => {
    const m = text.match(/next weekly reward is in\s*\*{0,2}\s*([0-9dhms\s]+)/i);
    if (!m) return null;
    const secs = parseTimeString(m[1].trim());
    return secs > 0 ? secs : null;   // a zero here means the parse failed, not "ready"
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
    // Mutes, quiet hours and the listening-back check all live in there.
    deliverReminder(userId, command, channel)
      .catch(err => console.error(`[reminder] ${command} for ${userId}: ${err.message}`));
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
  cooldownChannels.set(ckey(userId, command), channel);
  // Order matters: noteCommandRun reads lastActivityAt to tell "was around and
  // skipped it" from "had logged off", so it must run before this command
  // overwrites that with now.
  // Only a confirmed run settles a reminder — an `n cd` resync restates the same
  // cooldowns and must never be mistaken for the player acting on a ping.
  if (opts.ranNow) noteCommandRun(userId, command);
  lastActivityAt.set(userId, Date.now());

  // Arm the reminder timer
  if (cooldownSeconds > 0) armTimer(userId, command, expiryUnix, channel);

  // Persist to DB — fire-and-forget, never blocks the message handler
  if (!MEMORY_ONLY.has(command)) {
    database.collection.findOneAndUpdate(
      { userId },
      { $set: {
        [`cooldowns.${command}`]: { expiry: expiryUnix, channelId },
        // Who is actually playing. Used to keep window announcements off people
        // whose last command was months ago.
        lastSeen: new Date(),
      } },
      { upsert: true }
    ).catch(err => console.error(`[db] write failed for ${userId}/${command}: ${err.message}`));
  }

  return true;
};

/** Stamp a cooldown as announced, so a restart does not repeat the ping. */
const markNotified = (userId, command) => {
  if (MEMORY_ONLY.has(command)) return;
  database.collection.findOneAndUpdate(
    { userId, [`cooldowns.${command}`]: { $exists: true } },
    { $set: { [`cooldowns.${command}.notifiedAt`]: Math.floor(Date.now() / 1000) } }
  ).catch(err => console.error(`[db] notify mark failed for ${userId}/${command}: ${err.message}`));
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
    // A stated 0 is meaningful — "claimable right now" — so it must not fall
    // through to the table the way a failed parse (null) does.
    const stated = DURATION_FROM_TEXT[entry.command]?.(text) ?? null;
    const source = stated !== null ? 'stated' : 'table';
    const seconds = stated !== null ? stated : durationFor(entry.command);

    const armed = await saveCooldown(entry.userId, entry.command, seconds, message.channel, client, {
      authority: source === 'stated' ? AUTHORITY.stated
               : DYNAMIC_DURATIONS[entry.command] ? AUTHORITY.derived
               : AUTHORITY.table,
      ranNow: true,
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
      const seconds = stated !== null ? stated : durationFor(command);
      await saveCooldown(user.id, command, seconds, message.channel, client, {
        authority: stated !== null ? AUTHORITY.stated
                 : DYNAMIC_DURATIONS[command] ? AUTHORITY.derived
                 : AUTHORITY.table,
        ranNow: true,
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

// Feeds are logged optimistically when you type them. The game's reply decides
// whether that log stands.
//
//   "This ninja has already eaten a daily food"  → the ninja IS fed, so the
//        routine line is genuinely satisfied; keep it, just say so.
//   any other refusal                            → it did not eat; undo the log.
const FEED_ALREADY_EATEN = /already eaten a daily food/i;

// A mistyped or wrong id — the ninja definitely did not eat, and the routine
// entry itself is probably wrong.
const FEED_BAD_ID = /missing ninja id|no ninja with|invalid ninja/i;

const processFeedReply = async (message, text, ownerId) => {
  const pending = recentFeeds.get(message.channel.id);
  if (!pending) return;
  if (Date.now() - pending.at > CONFIRM_WINDOW_MS) { recentFeeds.delete(message.channel.id); return; }
  if (ownerId && ownerId !== pending.userId) return;

  if (FEED_ALREADY_EATEN.test(text)) {
    recentFeeds.delete(message.channel.id);
    trace('feed already eaten', { unit: pending.unitId });
    await safeSend(message.channel,
      `<@${pending.userId}> **${pending.unitId}** had already eaten today — ` +
      `counting it as done, but that \`${pending.item}\` wasn't spent.`);
    return;
  }

  if (FEED_BAD_ID.test(text)) {
    recentFeeds.delete(message.channel.id);
    await feed.unlogFeed(pending.key);
    trace('feed bad id', { unit: pending.unitId });
    await safeSend(message.channel,
      `<@${pending.userId}> **${pending.unitId}** isn't a valid ninja id — left it unticked. ` +
      `If it's in your routine, fix it with \`nh feed remove ${pending.unitId} ${pending.item}\`.`);
    return;
  }

  if (REJECTION_PATTERNS.some(re => re.test(text))) {
    recentFeeds.delete(message.channel.id);
    const undone = await feed.unlogFeed(pending.key);
    trace('feed refused', { unit: pending.unitId, undone });
    if (undone) {
      await safeSend(message.channel,
        `<@${pending.userId}> feeding **${pending.unitId}** didn't go through — ` +
        `left it unticked in \`nh feed\`.`);
    }
    return;
  }

  // Anything else that names the owner is treated as success; the log stands.
  if (ownerId === pending.userId) recentFeeds.delete(message.channel.id);
};

/**
 * Extra sections for the pre-reset nudge. Feeding runs on the same 24h clock as
 * the dailies, and an unfed ninja is XP that can't be recovered once the day
 * rolls over — so it belongs in the last call, not just in `nh feed`.
 */
const nudgeExtras = async (userId) => {
  const sections = [];
  try {
    const { entries, total, done } = await feed.pending(userId);
    if (entries.length) {
      sections.push(
        `🍜 **Feeds** — ${done}/${total} done\n` +
        entries.slice(0, 8).map(e => `> \`${feed.commandFor(e)}\``).join('\n') +
        (entries.length > 8 ? `\n> -# +${entries.length - 8} more` : '')
      );
    }
  } catch (err) {
    console.error(`[nudge] feed section failed for ${userId}: ${err.message}`);
  }
  return sections;
};

const persistQuiet = async (userId, cfg) => {
  database.collection.findOneAndUpdate(
    { userId },
    cfg ? { $set: { quiet: cfg } } : { $unset: { quiet: '' } },
    { upsert: true }
  ).catch(err => console.error(`[db] quiet write failed for ${userId}: ${err.message}`));
};

/**
 * `nh next` — everything competing for attention in one place: what is off
 * cooldown now, what lands soonest, feeds still due, and dailies still open.
 */
const buildNextReport = async (userId, username) => {
  const now   = Math.floor(Date.now() / 1000);
  const cache = cooldownCache.get(userId) ?? {};

  const ready   = [];
  const waiting = [];
  for (const [cmd, expiry] of Object.entries(cache)) {
    if (isMuted(userId, cmd)) continue;
    (expiry <= now ? ready : waiting).push([cmd, expiry]);
  }
  waiting.sort(([, a], [, b]) => a - b);

  // Any tracked command we've never seen is also fair game right now.
  for (const cmd of Object.keys(COOLDOWN_DURATIONS)) {
    if (cmd.startsWith('buy_')) continue;
    if (!(cmd in cache) && !isMuted(userId, cmd)) ready.push([cmd, now]);
  }

  // Feeds are actionable right now and expire at reset, so they rank with the
  // ready items rather than sitting below as a status footnote.
  let feeds = null;
  try { feeds = await feed.pending(userId); }
  catch (err) { console.error(`[next] feed lookup failed: ${err.message}`); }

  const feedsDue = feeds?.entries.length ?? 0;

  const lines = [`<@${userId}> **what's next**`];

  if (!ready.length && !feedsDue) {
    lines.push('\n😴 Nothing to do right now.');
  }

  if (ready.length) {
    lines.push(`\n✅ **Ready now:** ${ready.map(([c]) => `\`${c}\``).join(' · ')}`);
  }

  if (feedsDue) {
    const shown = feeds.entries.slice(0, 6).map(e => `> \`${feed.commandFor(e)}\``).join('\n');
    lines.push(
      `\n🍜 **Due today:** ${feedsDue} feed${feedsDue === 1 ? '' : 's'} left ` +
      `(${feeds.done}/${feeds.total} done)\n${shown}` +
      (feedsDue > 6 ? `\n> -# +${feedsDue - 6} more` : '')
    );
  } else if (feeds?.total) {
    lines.push(`\n🍜 **Feeds:** all ${feeds.total} done ✅`);
  }

  if (waiting.length) {
    const soon = waiting.slice(0, 4)
      .map(([c, e]) => `> \`${c}\` — ${formatDuration(e - now)}`).join('\n');
    lines.push(`\n⏳ **Coming up:**\n${soon}`);
  }

  // Dailies still open
  try {
    const snap = await dailies.latest(userId);
    if (snap) {
      const open = dailies.remaining(snap);
      const reset = snap.resetAt
        ? ` · resets <t:${Math.floor(new Date(snap.resetAt).getTime() / 1000)}:R>` : '';
      lines.push(open.length
        ? `\n📜 **Dailies:** ${open.length} open${reset}\n` +
          open.slice(0, 3).map(t => `> ${t.total - t.done} more · ${t.label}`).join('\n')
        : `\n📜 **Dailies:** all complete ✅${reset}`);
    }
  } catch { /* dailies data is optional here */ }

  // Invasion — a fixed daily window rather than a cooldown, so it sits outside
  // the "ready / coming up" split above.
  if (!isMuted(userId, 'invasion')) {
    const line = invasion.nextLine(userId);
    if (line) lines.push(`\n${line}`);
  }

  if (isReminderPaused(userId)) lines.push(`\n-# ⏸ reminders paused`);
  else if (quiet.isQuiet(userId)) lines.push(`\n-# 🌙 quiet hours — pings are being held`);

  return lines.join('\n');
};

// ─── Startup: restore cooldowns from DB ──────────────────────────────────────

const restoreCooldownsFromDB = async (client) => {
  console.log('[startup] Restoring cooldowns from DB...');
  try {
    const now   = Math.floor(Date.now() / 1000);
    const rows  = await database.find({}).lean();

    // There is no unique index on userId, so a player can own several documents
    // — one account here has seven. Processing them one at a time meant the last
    // document read *replaced* that user's cache instead of adding to it, so a
    // straggler holding a single stale cooldown silently wiped the six live ones
    // restored a moment earlier. Merge first, newest expiry per command wins.
    const users = [];
    const byId  = new Map();
    for (const row of rows) {
      const seen = byId.get(row.userId);
      if (!seen) {
        byId.set(row.userId, { ...row, cooldowns: { ...(row.cooldowns ?? {}) } });
        users.push(byId.get(row.userId));
        continue;
      }
      for (const [cmd, entry] of Object.entries(row.cooldowns ?? {})) {
        if (!entry?.expiry) continue;
        if (!seen.cooldowns[cmd] || entry.expiry > seen.cooldowns[cmd].expiry) {
          seen.cooldowns[cmd] = entry;
        }
      }
      // Settings live on whichever document happens to carry them.
      seen.disabled = seen.disabled ?? row.disabled;
      seen.quiet    = seen.quiet    ?? row.quiet;
      seen.tz       = seen.tz       ?? row.tz;
    }
    if (rows.length !== users.length) {
      console.warn(`[startup] ${rows.length} documents collapsed to ${users.length} players ` +
        `— ${rows.length - users.length} duplicate row(s); run \`nh db dedupe\` to clean up.`);
    }

    let restored = 0;

    for (const user of users) {
      if (!user.cooldowns || typeof user.cooldowns !== 'object') continue;

      const userCache = {};

      for (const [rawCommand, entry] of Object.entries(user.cooldowns)) {
        const command = normalizeCommand(rawCommand);
        if (RETIRED_COMMANDS.has(command)) continue;      // quests no longer exist
        if (!entry?.expiry || !entry?.channelId) continue; // skip malformed

        const remaining = entry.expiry - now;

        // Resolve the channel lazily so one dead channel can't stall startup.
        const lazyChannel = {
          id: entry.channelId,
          send: async (content) => {
            const channel = await client.channels.fetch(entry.channelId);
            return channel.send(content);
          },
        };

        // Expired while we were down. A person is not waiting on us: they play on
        // their own schedule, they can see the cooldown with `nh next`, and a ping
        // fired because the bot happened to reboot is noise. Restarts are silent.
        if (remaining <= 0) continue;

        userCache[command] = entry.expiry;
        cooldownCache.set(user.userId, userCache); // armTimer reads this
        setAuthority(user.userId, command, AUTHORITY.table); // unknown provenance
        restored++;

        cooldownChannels.set(ckey(user.userId, command), lazyChannel);
        armTimer(user.userId, command, entry.expiry, lazyChannel);
      }

      if (Object.keys(userCache).length > 0) cooldownCache.set(user.userId, userCache);

      // Reminder mutes live alongside the cooldowns. Values may be `true`
      // (legacy, indefinite), { until } or a daily { startMin, endMin, tz }.
      const rules = new Map();
      for (const [cmd, rule] of Object.entries(user.disabled ?? {})) {
        if (rule === true || rule?.until || rule?.startMin != null || rule?.auto) {
          rules.set(cmd, rule);
        }
      }
      if (rules.size) mutedCommands.set(user.userId, rules);

      // Timezone, so windows mean the same thing after a restart.
      if (user.tz !== undefined && user.tz !== null) userTz.set(user.userId, user.tz);

    }

    console.log(`[startup] Restored ${restored} cooldown(s) for ${users.length} user(s).`);
    console.log(`[startup] Loaded ${quiet.loadAll(users)} quiet-hour window(s), ` +
      `${userTz.size} custom timezone(s).`);

    // Daily digest at each reset, delivered to the channel the user plays in.
    digest.scheduleDaily(
      async () => users
        .map(u => ({
          userId: u.userId,
          channelId: Object.values(u.cooldowns ?? {})
            .map(c => c?.channelId).find(Boolean) ?? null,
        }))
        .filter(u => u.channelId),
      async (channelId) => {
        try { return await client.channels.fetch(channelId); }
        catch { return null; }
      },
      (userId) => isMuted(userId, 'digest')
    );

    // Invasion announcements go only to people who have played in the last day.
    // Read fresh at fire time, not from this startup snapshot, so someone who
    // stopped playing weeks ago drops off by themselves.
    const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
    const activePlayers = async () => {
      const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS);
      const rows = await database.collection
        .find({ lastSeen: { $gte: cutoff } }).toArray();
      return rows
        .map(u => ({
          userId: u.userId,
          channelId: Object.values(u.cooldowns ?? {}).map(c => c?.channelId).find(Boolean) ?? null,
        }))
        .filter(u => u.channelId);
    };

    console.log(`[startup] ${await invasion.loadToday()} invasion sign(s) already recorded today.`);
    invasion.scheduleWindows(
      activePlayers,
      async (channelId) => {
        try { return await client.channels.fetch(channelId); }
        catch { return null; }
      },
      isMuted,
      (userId) => quiet.isQuiet(userId)
    );

    console.log(`[startup] Report answers enabled in ${await loadReportChannels()} channel(s).`);

    await dailies.restoreNudges(
      async (channelId) => {
        if (!channelId) return null;
        try { return await client.channels.fetch(channelId); }
        catch { return null; }
      },
      (userId) => isReminderPaused(userId) || isMuted(userId, 'dailies'),
      nudgeExtras
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
  handleComponent: (...args) => handleComponent(...args),
};

/**
 * Message-component interactions. Only the timezone picker for now.
 *
 * The customId carries the id of whoever ran `nh tz`, so someone else clicking
 * the same dropdown cannot change their setting — the menu sits in a shared
 * channel and Discord will happily deliver anyone's click.
 */
const handleComponent = async (interaction) => {
  if (!interaction.isStringSelectMenu?.()) return false;
  const [kind, ownerId] = String(interaction.customId).split(':');
  if (kind !== 'tz') return false;

  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      content: 'That picker belongs to someone else — run `nh tz` to get your own.',
      ephemeral: true,
    });
    return true;
  }

  const zone = interaction.values?.[0];
  const tz = quiet.parseTimezone(zone);
  if (tz === null) {
    await interaction.reply({ content: `Couldn't read **${zone}**.`, ephemeral: true });
    return true;
  }

  const cfg = await applyTimezone(ownerId, tz);
  await interaction.update({
    content:
      `<@${ownerId}> 🕒 timezone set to **${quiet.describeTz(tz)}**` +
      ` — it is **${quiet.clockIn(zone)}** there now.` +
      (cfg ? `\n-# quiet hours re-read in it: **${quiet.describe(ownerId)}**` : '') +
      `\n-# every window you set — \`nh quiet\`, \`nh pause <cmd> 16:00-05:30\` — now uses this.`,
    components: [],
  });
  console.log(`[tz] ${ownerId} set ${zone} via picker`);
  return true;
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

  // ── Invasion sign confirmed ───────────────────────────────────────────────
  // Names the player itself ("...were signed for invasion defense **eiota**!"),
  // so it does not depend on extractOwner, which keys off the "X's page" form
  // this message does not use.
  const signed = invasion.parseSign(text);
  if (signed) {
    const user = findUserByUsername(client, signed.username);
    if (user) {
      const { username, ...info } = signed;
      await invasion.recordSign(user.id, info);
      console.log(`[invasion] ${signed.username} signed — ` +
        `${signed.power?.toLocaleString?.()} power, ${signed.resignsLeft ?? '?'} re-signs left`);
    } else {
      trace('invasion sign, unknown user', { username: signed.username });
    }
    return;   // nothing else parses this message
  }

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
    if (riddle && !riddle.answered && !isMuted(ownerId, 'answers')) {
      riddle.answered = true;
      // Naming the button is only allowed in channels explicitly whitelisted for
      // it; everywhere else this just repeats the detail you were shown.
      const showOption = mayShowReportOption(message.channel.id);
      const options = showOption ? reports.parseOptions(text) : [];
      // Plain name, not a mention — this fires while you're watching the timer.
      const line = ownerId ? reports.format(owner, riddle.info, options, { showOption }) : null;
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

  // Daily tier completions arrive as their own message and — unusually — mention
  // the user outright, so they resolve even for someone we've never seen speak.
  const tier = dailies.parseTierCompletion(text);
  if (tier) {
    const tierUser = message.mentions?.users?.first()?.id ?? ownerId;
    if (tierUser) {
      await dailies.applyTierCompletion(tierUser, tier);
      // Tier rewards are real ryo income that nothing was recording.
      if (tier.ryo) {
        await xptracker.recordExternal(tierUser, 'daily_tier', 0, tier.ryo, `${message.id}:tier`);
      }
      trace('daily tier', { user: tierUser, label: tier.label, tier: tier.tier, ryo: tier.ryo });
    }
  }

  // Jutsu upgrade prompt — answer the affordability question while the
  // yes/no is still open. No mention, same reasoning as the report helper.
  const upgrade = jutsu.parse(text);
  if (upgrade) {
    // This page names the user at the end rather than in a header.
    const name = upgrade.user ?? owner;
    const id   = name ? resolveUserId(client, name) : ownerId;
    if (id && !isMuted(id, 'jutsu')) {
      const verdict = await jutsu.check(id, upgrade, name).catch(() => null);
      if (verdict) {
        await safeSend(message.channel, verdict);
        trace('jutsu check', { user: name, unit: upgrade.unitId, to: upgrade.to });
      }
    } else if (!id) {
      trace('jutsu check skipped — unknown user', { name });
    }
  }

  // A refusal states the real remaining cooldown — the strongest correction
  // available, and proof the last reminder was early.
  await processCooldownRefusal(message, text, client);

  await processFeedReply(message, text, ownerId);

  // Item stock, from the bare `n feed` page
  if (ownerId) {
    const stock = feed.parseStock(text);
    if (stock) {
      feed.recordStock(ownerId, stock);
      trace('feed stock', { user: owner, ...stock });
    }
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
        () => isReminderPaused(ownerId) || isMuted(ownerId, 'dailies'),
        nudgeExtras
      );
      trace('dailies', { user: owner, open: dailies.remaining(daily).length });
    }

    // Monthly Pass level + progress
    const pass = monthly.parse(text);
    if (pass) {
      await monthly.record(ownerId, pass);
      trace('pass', { user: owner, ...pass });
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

// Light per-person throttle on `nh` commands. Several of them run a handful of
// database queries, and with the bot open to everyone one person holding down
// enter shouldn't be able to slow it for the rest. Game commands are untouched.
const NH_THROTTLE_MS = 2000;
const lastNhAt = new Map();

const handleUserMessage = async (message, client) => {
  rememberUser(message.author); // so the game bot's "eiota's …" resolves to an id

  if (/^nh\s/i.test(message.content)) {
    const last = lastNhAt.get(message.author.id) ?? 0;
    if (Date.now() - last < NH_THROTTLE_MS) return;   // silently ignore the burst
    lastNhAt.set(message.author.id, Date.now());
  }

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

  // ── nh tz [zone] — what "23:00" means for you ────────────────────────────
  const tzMatch = lower.match(/^nh\s+(?:tz|timezone)(?:\s+(.+))?$/);
  if (tzMatch) {
    const raw = tzMatch[1]?.trim();

    if (!raw) {
      const set = userTz.has(userId);
      try {
        await message.channel.send({
          content:
            `<@${userId}> 🕒 your timezone: **${quiet.describeTz(tzFor(userId))}**` +
            `${set ? '' : ' — the default, not your own'}\n` +
            `-# Pick below, or type \`nh tz Europe/Berlin\` / \`nh tz +02:00\`. ` +
            `\`nh tz off\` restores the default.`,
          components: [buildTzPicker(userId)],
        });
      } catch (err) {
        // Components can fail on missing permissions; the typed form still works.
        console.warn(`[tz] picker failed for ${userId}: ${err.message}`);
        await safeSend(message.channel,
          `<@${userId}> 🕒 your timezone: **${quiet.describeTz(tzFor(userId))}**\n` +
          `-# set it with \`nh tz Europe/Berlin\` or \`nh tz +02:00\``);
      }
      return;
    }

    if (raw === 'off' || raw === 'clear' || raw === 'reset') {
      userTz.delete(userId);
      await persistTz(userId, null);
      await safeSend(message.channel,
        `<@${userId}> timezone cleared — back to the ${quiet.describeTz(quiet.DEFAULT_TZ_MINUTES)} default.`);
      return;
    }

    // Case matters for IANA names, so parse the original text, not `lower`.
    const original = message.content.trim().replace(/^nh\s+(?:tz|timezone)\s+/i, '');
    const tz = quiet.parseTimezone(original);
    if (tz === null) {
      await safeSend(message.channel,
        `<@${userId}> couldn't read **${original}**. Try a zone name like ` +
        `\`Europe/Berlin\`, \`America/New_York\`, \`Asia/Kolkata\` — or an offset like \`+02:00\`.`);
      return;
    }

    const cfg = await applyTimezone(userId, tz);

    await safeSend(message.channel,
      `<@${userId}> 🕒 timezone set to **${quiet.describeTz(tz)}**.` +
      (cfg ? `\n-# quiet hours re-read in it: **${quiet.describe(userId)}**` : '') +
      (typeof tz === 'number'
        ? `\n-# a fixed offset will not follow daylight saving — a zone name like \`Europe/Berlin\` does`
        : ''));
    return;
  }

  // ── nh quiet [HH:MM-HH:MM | off] — hold pings overnight ──────────────────
  const quietMatch = lower.match(/^nh\s+quiet(?:\s+(.+))?$/);
  if (quietMatch) {
    const arg = quietMatch[1]?.trim();

    if (!arg) {
      const window = quiet.describe(userId);
      await safeSend(message.channel, window
        ? `<@${userId}> 🌙 quiet hours **${window}**` +
          (quiet.pendingCount(userId) ? ` · ${quiet.pendingCount(userId)} reminder(s) held` : '') +
          `\n-# \`nh quiet off\` to clear`
        : `<@${userId}> no quiet hours set. Try \`nh quiet 23:00-08:00\` ` +
          `— read in **${quiet.describeTz(tzFor(userId))}**` +
          `${userTz.has(userId) ? '' : ', the default'}. \`nh tz\` to change that.`);
      return;
    }

    if (arg === 'off' || arg === 'clear' || arg === 'none') {
      quiet.setConfig(userId, null);
      await persistQuiet(userId, null);
      await safeSend(message.channel, `<@${userId}> quiet hours cleared.`);
      return;
    }

    const cfg = quiet.parseWindow(arg, tzFor(userId));
    if (!cfg) {
      await safeSend(message.channel,
        `<@${userId}> couldn't read that. Use \`nh quiet 23:00-08:00\` ` +
        `(add \`+00:00\` for a different timezone).`);
      return;
    }
    quiet.setConfig(userId, cfg);
    await persistQuiet(userId, cfg);
    await safeSend(message.channel,
      `<@${userId}> 🌙 quiet hours set to **${quiet.describe(userId)}**. ` +
      `Reminders in that window are held and delivered together when it ends.` +
      `${userTz.has(userId) ? '' : `\n-# read in ${quiet.describeTz(quiet.DEFAULT_TZ_MINUTES)} — \`nh tz\` if that is not yours`}`);
    return;
  }

  // ── nh next — one dashboard: what to do right now ────────────────────────
  if (/^nh\s+next$/.test(lower)) {
    await safeSend(message.channel, await buildNextReport(userId, message.author.username));
    return;
  }

  // ── nh dailies — progress toward today's set ─────────────────────────────
  if (/^nh\s+(dailies|daily|d)$/.test(lower)) {
    await safeSend(message.channel, await dailies.report(userId).catch(() =>
      `<@${userId}> couldn't read dailies data right now.`));
    return;
  }

  // ── nh missions [days] — counts and payout by rank ───────────────────────
  const missionsMatch = lower.match(/^nh\s+(?:missions|ranks)(?:\s+(\d+))?$/);
  if (missionsMatch) {
    const days = Math.min(30, Math.max(1, parseInt(missionsMatch[1] ?? '7', 10)));
    await safeSend(message.channel, await xptracker.missionReport(userId, days).catch(() =>
      `<@${userId}> couldn't read mission data right now.`));
    return;
  }

  // ── nh util [24h|week] — how much of each cooldown you actually used ─────
  const utilMatch = lower.match(/^nh\s+(?:util|utilisation|utilization|usage)(?:\s+(\w+))?$/);
  if (utilMatch) {
    const windows = {
      today: [null, "since today's reset"],
      '24h': [86_400_000, 'last 24h'],
      day:   [86_400_000, 'last 24h'],
      week:  [7 * 86_400_000, 'last 7 days'],
      '7d':  [7 * 86_400_000, 'last 7 days'],
    };
    const [sinceMs, label] = windows[utilMatch[1]] ?? windows.today;

    // Only the fast, repeatable commands say anything useful about uptime — a
    // weekly cooldown at 0/1 tells you nothing about whether the bot was up.
    const tracked = {
      mission:   COOLDOWN_DURATIONS.mission,
      report:    COOLDOWN_DURATIONS.report,
      challenge: COOLDOWN_DURATIONS.challenge,
      train:     COOLDOWN_DURATIONS.train,
    };

    await safeSend(message.channel,
      await xptracker.utilisationReport(userId, tracked, sinceMs, label).catch((err) => {
        console.error('[util] report failed:', err.message);
        return `<@${userId}> couldn't read utilisation data right now.`;
      }));
    return;
  }

  // ── nh streak — consecutive fully-cleared days ───────────────────────────
  if (/^nh\s+streaks?$/.test(lower)) {
    await safeSend(message.channel, await digest.streakReport(userId).catch(() =>
      `<@${userId}> couldn't read streak data right now.`));
    return;
  }

  // ── nh pass — Monthly Pass level and the pace to finish it ───────────────
  if (/^nh\s+(pass|monthly)$/.test(lower)) {
    await safeSend(message.channel, await monthly.report(userId).catch(() =>
      `<@${userId}> couldn't read Monthly Pass data right now.`));
    return;
  }

  // ── nh digest — preview yesterday's summary on demand ────────────────────
  if (/^nh\s+digest$/.test(lower)) {
    const text = await digest.build(userId).catch(() => null);
    await safeSend(message.channel, text ??
      `<@${userId}> nothing recorded for yesterday yet.`);
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
    const [, verb, raw] = muteMatch;
    const target = MUTE_ALIASES[raw] ?? raw;

    if (!MUTABLE.has(target)) {
      await safeSend(message.channel,
        `<@${userId}> unknown reminder **${raw}**. Options: ${[...MUTABLE].join(', ')}`);
      return;
    }

    await setMuted(userId, target, verb === 'off' ? true : null);
    if (verb === 'on') {
      // Asking for it back is the clearest signal there is — start them level,
      // or the bot is already two strikes into resting it again.
      if (target === 'all') {
        for (const k of [...ignoredStreak.keys()]) {
          if (k.startsWith(`${userId}:`)) ignoredStreak.delete(k);
        }
      } else ignoredStreak.delete(ckey(userId, target));
    }
    const what = target === 'answers' ? 'report answer helper'
               : target === 'digest'  ? 'daily digest'
               : `**${target}** reminders`;
    await safeSend(message.channel,
      verb === 'off'
        ? `<@${userId}> 🔕 ${what} muted. \`nh on ${target}\` to undo.`
        : `<@${userId}> 🔔 ${what} back on.`);
    return;
  }

  // ── nh mutes — what's currently silenced ─────────────────────────────────
  if (/^nh\s+(mutes|toggles)$/.test(lower)) {
    const rules = mutedCommands.get(userId);
    const live = [...(rules ?? [])].filter(([, r]) => ruleActive(r) || r === true || r?.startMin != null);
    await safeSend(message.channel,
      live.length
        ? `<@${userId}> **silenced:**\n` + live
            .map(([c, r]) => `> **${c}** — ${describeRule(r)}${ruleActive(r) ? '' : ' -# (not right now)'}`)
            .join('\n')
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

  // ── nh whitelist [here|<id>|remove <id>] — report-answer channels ─────────
  const wlMatch = message.content.trim().match(/^nh\s+(?:whitelist|wl)\b\s*(.*)$/i);
  if (wlMatch) {
    const arg = wlMatch[1].trim();

    // Listing is harmless; changing it is not.
    if (!arg || arg === 'list') {
      const ids = [...reportChannels];
      await safeSend(message.channel,
        ids.length
          ? `<@${userId}> 📝 report answers are enabled in:\n` +
            ids.map(id => `> <#${id}> \`${id}\``).join('\n') +
            `\n-# everywhere else only repeats the detail, never the option`
          : `<@${userId}> report answers are **off everywhere** — the helper repeats ` +
            `the detail you were shown but never names the option.\n` +
            `-# \`nh whitelist here\` to allow it in this channel`);
      return;
    }

    if (!canManageChannels(message)) {
      await safeSend(message.channel,
        `<@${userId}> only a server admin can change this.`);
      return;
    }

    const removing = /^(remove|rm|off|delete)\b/i.test(arg);
    const raw = removing ? arg.replace(/^\w+\s*/, '').trim() : arg;
    const target = (!raw || raw === 'here') ? message.channel.id : raw.replace(/[<#>]/g, '');

    if (!/^\d{17,20}$/.test(target)) {
      await safeSend(message.channel,
        `<@${userId}> that doesn't look like a channel id. Use \`nh whitelist here\` ` +
        `or \`nh whitelist <channel id>\`.`);
      return;
    }

    if (removing) {
      if (!reportChannels.delete(target)) {
        await safeSend(message.channel, `<@${userId}> <#${target}> wasn't whitelisted.`);
        return;
      }
      await saveReportChannels();
      await safeSend(message.channel,
        `<@${userId}> 🔒 report answers disabled in <#${target}> — back to detail only.`);
      return;
    }

    if (reportChannels.has(target)) {
      await safeSend(message.channel, `<@${userId}> <#${target}> is already whitelisted.`);
      return;
    }
    reportChannels.add(target);
    await saveReportChannels();
    await safeSend(message.channel,
      `<@${userId}> ✅ report answers enabled in <#${target}>.\n` +
      `-# the helper will now name the option to click there · ` +
      `\`nh whitelist remove ${target}\` to undo`);
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

  // ── nh pause <cmd> <2h | 16:00-05:30> — silence ONE reminder ─────────────
  // Checked before the all-commands form below, which only matches a bare
  // duration and so can never swallow this.
  const pauseOne = message.content.trim().match(
    /^nh\s+pause\s+([a-z_0-9]+)\s+(.+)$/i);
  if (pauseOne) {
    const target = MUTE_ALIASES[pauseOne[1].toLowerCase()] ?? pauseOne[1].toLowerCase();
    const spec   = pauseOne[2].trim();

    if (!MUTABLE.has(target)) {
      await safeSend(message.channel,
        `<@${userId}> unknown reminder **${pauseOne[1]}**. Options: ${[...MUTABLE].join(', ')}`);
      return;
    }

    // A clock window ("16:00-05:30") repeats daily; a duration ("2h") expires once.
    const window = quiet.parseWindow(spec, tzFor(userId));
    if (window) {
      await setMuted(userId, target, window);
      await safeSend(message.channel,
        `<@${userId}> 🔕 **${target}** reminders silenced daily between ` +
        `**${quiet.describeWindow(window)}**.\n` +
        `-# repeats every day · \`nh on ${target}\` to clear`);
      return;
    }

    const dur = spec.match(/^(\d+)\s*(h|m|hr|hrs|hour|hours|min|mins|minute|minutes)$/i);
    if (dur) {
      const n = parseInt(dur[1], 10);
      const seconds = /^m/i.test(dur[2]) ? n * 60 : n * 3600;
      const until = Math.floor(Date.now() / 1000) + seconds;
      await setMuted(userId, target, { until });
      await safeSend(message.channel,
        `<@${userId}> 🔕 **${target}** reminders off until <t:${until}:t> ` +
        `(<t:${until}:R>).\n-# \`nh on ${target}\` to bring them back sooner`);
      return;
    }

    await safeSend(message.channel,
      `<@${userId}> couldn't read "${spec}". Try \`nh pause ${target} 2h\` ` +
      `or \`nh pause ${target} 16:00-05:30\`.`);
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
  // Keyed on the channel, not the person who typed it. `n cd @someone` returns
  // *their* page, so keying on the typer left the suppression looking for one id
  // while the embed handler checked another — and the confirmation went out,
  // pinging someone who had not asked for anything.
  if (/^n\s+cd\b/.test(lower)) {
    cdCheckSuppressed.add(message.channel.id);
    setTimeout(() => cdCheckSuppressed.delete(message.channel.id), 5000).unref();
    return;
  }

  // ── n feed <id> <item> — tick the routine off as you go ──────────────────
  const fedMatch = lower.match(/^n\s+feed\s+(\d+)\s+(\S+)/);
  if (fedMatch) {
    // Logged optimistically so the checklist stays responsive, but remembered
    // so a hard refusal can undo it — see processFeedReply.
    await feed.logFeed(userId, fedMatch[1], fedMatch[2], message.id);
    recentFeeds.set(message.channel.id, {
      userId, unitId: fedMatch[1], item: fedMatch[2], key: message.id, at: Date.now(),
    });
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

  // The game bot edits this page in place, and edits route back through here so
  // the numbers stay fresh. Saving twice is harmless — announcing twice is not.
  const announced = cdAnnounced.has(message.id);
  cdAnnounced.set(message.id, Date.now());

  // Triggered by someone typing `n cd` in this channel? Then they are looking
  // straight at the page and a confirmation adds nothing.
  const isSilent = announced || cdCheckSuppressed.has(message.channel.id);

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

// When the game refuses a command it states exactly how long is left, e.g.
//   "Wait 39s for your next mission **eiota**."
//   "Wait 2h 7m 3s for your next tower challenge **eiota**."
//   "You next report will be ready in 10 minutes **eiota**!"
// That is a better cooldown than anything we hold, and it is the direct evidence
// that our reminder fired early. Folding it back in stops the drift at source.
const REFUSAL = {
  wait:  /wait\s+`?([\dhms.\s]+?)`?\s+(?:before|for)\s+your next\s+([a-z ]+?)\s*\*\*/i,
  ready: /you'?r?e?\s*next\s+([a-z]+)\s+will be ready\s+([^*]+?)\s*\*\*/i,
  who:   /\*\*([^*\n]+?)\*\*/,
};

// What the game calls an activity → our command name.
const REFUSAL_COMMANDS = {
  mission: 'mission', report: 'report', challenge: 'challenge',
  training: 'train', 'tower challenge': 'tower', tower: 'tower',
  'weekly reward': 'weekly', 'daily reward': 'daily',
};

const processCooldownRefusal = async (message, text, client) => {
  let command = null, durationText = null;

  const wait = text.match(REFUSAL.wait);
  if (wait) {
    durationText = wait[1].trim();
    command = REFUSAL_COMMANDS[wait[2].trim().toLowerCase()] ?? null;
  } else {
    const ready = text.match(REFUSAL.ready);
    if (ready) {
      command = REFUSAL_COMMANDS[ready[1].trim().toLowerCase()] ?? null;
      durationText = ready[2].replace(/^in\s+/i, '').trim();
    }
  }
  if (!command) return false;

  // "27m 12s" and "10 minutes" both need to parse.
  let seconds = parseTimeString(durationText);
  if (!seconds) {
    let total = 0;
    for (const m of durationText.matchAll(/(\d+)\s*(day|hour|minute|second)s?\b/gi)) {
      total += parseInt(m[1], 10) * ({ d: 86400, h: 3600, m: 60, s: 1 })[m[2][0].toLowerCase()];
    }
    seconds = total;
  }
  if (!seconds || seconds <= 0) return false;

  const name = text.match(REFUSAL.who)?.[1]?.trim();
  const user = name ? findUserByUsername(client, name) : null;
  if (!user) { trace('refusal — unknown user', { name, command, seconds }); return false; }

  const corrected = await saveCooldown(user.id, command, seconds, message.channel, client,
    { authority: AUTHORITY.stated });
  trace('cooldown from refusal', { user: name, command, seconds, corrected });
  return corrected;
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
  const updated = await saveCooldown(user.id, "tower", COOLDOWN_DURATIONS.tower, message.channel, client, { ranNow: true });
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
      const updated = await saveCooldown(last.challengerId, "challenge", COOLDOWN_DURATIONS.challenge, message.channel, client, { ranNow: true });
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

  // Pass the name through untouched — findUserByUsername handles the variants.
  const rawName  = userMatch[1].trim();
  const user     = findUserByUsername(client, rawName);
  if (!user) return;

  const key      = `buy_${itemMatch[1].toLowerCase()}`;
  const duration = COOLDOWN_DURATIONS[key];
  if (!duration) return;

  // The purchase message states when the offer is buyable again. Use it when
  // present; the table value is only a fallback and is marked as a guess so a
  // later `n cd` can correct it.
  const stamp = message.content.match(/<t:(\d+)/);
  const stated = stamp ? parseInt(stamp[1], 10) - Math.floor(Date.now() / 1000) : null;
  const useStated = stated !== null && stated > 0;

  const updated = await saveCooldown(
    user.id, key, useStated ? stated : duration, message.channel, client,
    { authority: useStated ? AUTHORITY.stated : AUTHORITY.table, ranNow: true }
  );

  if (updated) {
    await safeSend(message.channel,
      useStated
        ? `Reminder set for **${itemMatch[1]}** — <t:${stamp[1]}:R>.`
        : `YaY ~${duration / 3600}h reminder set for **${itemMatch[1]}** vote shop cooldown.\n` +
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
  // Pass the name through untouched — findUserByUsername handles the variants.
  const rawName = userMatch[1].trim();
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
