// ─── Debug capture ────────────────────────────────────────────────────────────
// Dumps the complete shape of every message the bot sees, so message formats can
// be read off real traffic instead of guessed at. Inert unless DEBUG_CAPTURE is
// set, so it is safe to leave wired up in production.
//
//   DEBUG_CAPTURE=all                  capture every channel
//   DEBUG_CAPTURE=<id>,<id>            capture only these channel ids
//   DEBUG_CAPTURE_BOTS=1               capture bot messages only (skip humans)
//   DEBUG_CAPTURE_FILE=./capture.jsonl also append one JSON object per line
//   DEBUG_TRACE=1                      log why main.js armed/dropped a cooldown
//
// Example:
//   DEBUG_CAPTURE=<channel id> DEBUG_CAPTURE_FILE=./capture.jsonl npm start

const fs = require('fs');

const RAW      = process.env.DEBUG_CAPTURE ?? '';
const ENABLED  = RAW.length > 0;
const ALL      = RAW === 'all' || RAW === '*';
const CHANNELS = new Set(RAW.split(',').map(s => s.trim()).filter(Boolean));
const BOTS_ONLY = process.env.DEBUG_CAPTURE_BOTS === '1';
const FILE      = process.env.DEBUG_CAPTURE_FILE || null;

const TRACE = process.env.DEBUG_TRACE === '1' || ENABLED;

const { GAME_BOT_ID: NARUTO_BOT_ID } = require('./config');

// Discord component types, so dumps read as names rather than numbers.
const COMPONENT_TYPES = {
  1: 'ActionRow',      2: 'Button',        3: 'StringSelect',  4: 'TextInput',
  5: 'UserSelect',     6: 'RoleSelect',    7: 'MentionableSelect', 8: 'ChannelSelect',
  9: 'Section',       10: 'TextDisplay',  11: 'Thumbnail',    12: 'MediaGallery',
  13: 'File',         14: 'Separator',    17: 'Container',
};

const shouldCapture = (message) => {
  if (!ENABLED) return false;
  if (!ALL && !CHANNELS.has(message.channel?.id)) return false;
  if (BOTS_ONLY && !message.author?.bot) return false;
  return true;
};

// Walk the Components V2 tree, preserving structure and naming each node.
const describeComponents = (nodes, depth = 0) => {
  const out = [];
  for (const node of nodes ?? []) {
    const data = node?.data ?? node ?? {};
    const entry = { type: COMPONENT_TYPES[data.type] ?? data.type };

    if (typeof data.content === 'string') entry.text = data.content;
    if (typeof data.label === 'string') entry.label = data.label;
    if (data.custom_id ?? data.customId) entry.customId = data.custom_id ?? data.customId;
    if (data.url) entry.url = data.url;
    if (data.media?.url) entry.media = data.media.url;
    if (data.disabled != null) entry.disabled = data.disabled;

    const children = [];
    for (const key of ['components', 'accessory', 'items']) {
      const child = node?.[key] ?? data?.[key];
      if (Array.isArray(child)) children.push(...describeComponents(child, depth + 1));
      else if (child) children.push(...describeComponents([child], depth + 1));
    }
    if (children.length) entry.children = children;

    out.push(entry);
  }
  return out;
};

// Every readable string in the message, flattened — this is what main.js matches on.
const flattenText = (nodes, out = []) => {
  for (const node of nodes ?? []) {
    const data = node?.data ?? node ?? {};
    if (typeof data.content === 'string' && data.content.length) out.push(data.content);
    if (typeof data.label === 'string' && data.label.length) out.push(`[button] ${data.label}`);
    for (const key of ['components', 'accessory', 'items']) {
      const child = node?.[key] ?? data?.[key];
      if (Array.isArray(child)) flattenText(child, out);
      else if (child) flattenText([child], out);
    }
  }
  return out;
};

const snapshot = (message, kind = 'create') => {
  const flags = message.flags?.bitfield ?? 0;

  let components = [], flatText = [], raw = null;
  try {
    components = describeComponents(message.components);
    flatText   = flattenText(message.components);
    raw        = JSON.parse(JSON.stringify(message.components ?? []));
  } catch (err) {
    components = [{ error: err.message }];
  }

  return {
    at:   new Date().toISOString(),
    kind,
    who:  message.author?.id === NARUTO_BOT_ID ? 'NARUTO-BOT'
        : message.author?.bot                  ? `BOT:${message.author?.username}`
        : `USER:${message.author?.username}`,
    authorId:  message.author?.id ?? null,
    channelId: message.channel?.id ?? null,
    messageId: message.id,
    replyTo:   message.reference?.messageId ?? null,
    flags,
    isV2:      Boolean(flags & 32768), // IS_COMPONENTS_V2
    editedAt:  message.editedAt?.toISOString?.() ?? null,
    mentions:  message.mentions?.users?.map?.(u => `${u.username}:${u.id}`) ?? [],
    content:   message.content || null,
    embeds: (message.embeds ?? []).map(e => ({
      title:       e.title ?? null,
      description: e.description ?? null,
      author:      e.author?.name ?? null,
      footer:      e.footer?.text ?? null,
      url:         e.url ?? null,
      fields:      (e.fields ?? []).map(f => ({ name: f.name, value: f.value })),
    })),
    attachments: [...(message.attachments?.values?.() ?? [])].map(a => a.url),
    components,
    flatText,
    rawComponents: components.length === 0 ? raw : undefined,
  };
};

const write = (snap) => {
  console.log('\n===CAPTURE===\n' + JSON.stringify(snap, null, 2));
  if (!FILE) return;
  try {
    fs.appendFileSync(FILE, JSON.stringify(snap) + '\n');
  } catch (err) {
    console.error(`[debug] Could not append to ${FILE}: ${err.message}`);
  }
};

const capture = (message, kind) => {
  if (!shouldCapture(message)) return;
  try {
    write(snapshot(message, kind));
  } catch (err) {
    console.error(`[debug] capture failed for ${message?.id}: ${err.message}`);
  }
};

// Decision trace — main.js calls this to explain what it did and why.
const trace = (...args) => {
  if (TRACE) console.log('[trace]', ...args);
};

module.exports = { capture, trace, snapshot, describeComponents, flattenText, ENABLED, TRACE };
