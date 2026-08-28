// ─── Help content ─────────────────────────────────────────────────────────────
// Single source of truth for what the bot does. Kept apart from the command so
// the text is easy to keep in step with the code as features land.

const OWNER_ID = '000000000000000000';

// Cooldowns the bot arms, in the order they matter day to day.
const COOLDOWNS = [
  ['mission',  '`n m`',            '1m'],
  ['report',   '`n r`',            '10m'],
  ['challenge','`n ch` → a win',   '30m'],
  ['train',    '`n tr <tier>`',    '1h'],
  ['tower',    'a tower win',      '6h'],
  ['daily',    '`n d`',            'until 00:00 UTC'],
  ['weekly',   '`n w`',            '7d'],
  ['buy_v15',  'vote shop v15',    '20h'],
  ['buy_v20',  'vote shop v20',    '44h'],
];

const OVERVIEW = {
  title: '❓ Naruto helper — command list',
  description:
    'I watch Naruto Botto and set cooldown reminders — but only once the bot **confirms ' +
    'your command actually ran**. Maintenance, errors and cooldown refusals no longer ' +
    'arm a reminder.\n\nUse **`nh help <topic>`** for detail on any group below.',
  fields: [
    {
      name: '🧭 Right now — `nh next`',
      value: 'One view: what is off cooldown, what lands soonest, feeds still due,\n' +
             'and dailies still open.',
    },
    {
      name: '⏰ Reminders — `nh help reminders`',
      value:
        '`nh status` — every active cooldown, soonest first\n' +
        '`nh pause <Xh|Xm>` · `nh resume` — silence everything for a while\n' +
        '`nh off <cmd>` · `nh on <cmd>` · `nh mutes` — silence one reminder\n' +
        '`nh quiet 23:00-08:00` — hold overnight pings, deliver them together',
    },
    {
      name: '💎 Pass & digest',
      value:
        '`nh pass` — Monthly Pass level and the pace needed to finish it\n' +
        '`nh digest` — yesterday\'s XP, ryo, dailies and feeds (also posts at reset)',
    },
    {
      name: '🍜 Feed routine — `nh help feed`',
      value:
        '`nh feed` — what is still due today, and the next command to send\n' +
        '`nh feed set <lines>` — save your whole routine in one paste\n' +
        '`nh feed add 223 rl` · `nh feed remove 4` · `nh feed done` · `nh feed clear`',
    },
    {
      name: '📝 Report helper — `nh help reports`',
      value:
        'When `n r` asks you to pick the info back out of three options, I read the\n' +
        'earlier info page and tell you which one matches. Automatic, no command.',
    },
    {
      name: '📈 XP & levelling — `nh help xp`',
      value:
        '`nh xp` — gained since reset, xp/hr, and level-up ETA per ninja\n' +
        '`nh xp <name>` — just one ninja\n' +
        '`nh track xp <id>` · `nh end track xp <id>` — manual before/after session',
    },
    {
      name: '📜 Dailies — `nh help dailies`',
      value:
        '`nh dailies` (also `nh daily`, `nh d`) — progress on today\'s set\n' +
        'Auto-nudge **3h before reset** listing only what is still open',
    },
    {
      name: '💰 Economy — `nh help ryo`',
      value:
        '`nh ryo` (also `nh econ`) — ryo earned/spent by source, and what your\n' +
        'balance affords in pulls. React 🔢 on an `n bal` page for a quick count.',
    },
    {
      name: '⚙️ Utility',
      value: '`nh help [topic]` · `nh ping` · `nh stats` — also as `/help`, `/ping`, `/stats`',
    },
    {
      name: '🗄️ Admin — `nh help admin`',
      value: '`nh db …` — owner only, database inspection and cleanup',
    },
  ],
  footer: 'Everything is read from pages the game bot already sends — nothing is scraped or automated for you.',
};

const TOPICS = {
  reminders: {
    title: '⏰ Reminders',
    description:
      'Typing a command **arms an intent**; the cooldown is only saved once the game ' +
      'bot replies in a way that proves the command ran. If it replies with maintenance, ' +
      'an error, or "still on cooldown", nothing is armed and you get one short notice ' +
      'instead. If it says nothing at all within 30s, the intent quietly expires.',
    fields: [
      {
        name: 'Tracked cooldowns',
        value: COOLDOWNS.map(([n, src, d]) => `• **${n}** — ${src} · ${d}`).join('\n'),
      },
      {
        name: 'Where the timings come from',
        value:
          'When the bot states a real time, that wins over the table above:\n' +
          '• dailies — `Resets <t:…>` on the `n d` page\n' +
          '• weekly — "your next weekly reward is in 6d 23h…"\n' +
          '• `n cd` — every remaining time at once, the most reliable source\n\n' +
          'Values the bot only *guesses* (tower, challenge, and the vote shop, where the ' +
          'game states no time) can be **corrected** by any better source — so if a ' +
          'reminder lands a few minutes early, run `n cd` once and it self-corrects.',
      },
      {
        name: 'Controls',
        value:
          '`nh status` — active cooldowns + next dailies reset\n' +
          '`nh pause 2h` / `nh pause 30m` — mute everything temporarily\n' +
          '`nh resume` — unpause early\n' +
          '`nh off mission` — mute one reminder permanently\n' +
          '`nh off all` — mute every reminder\n' +
          '`nh on mission` / `nh on all` — turn back on\n' +
          '`nh mutes` (or `nh toggles`) — list what is currently silenced',
      },
      {
        name: 'Quiet hours',
        value:
          'Dailies reset at 05:30 IST, so that reminder lands overnight. A quiet window ' +
          '**holds** pings rather than dropping them and delivers one summary when it ends.\n' +
          '`nh quiet 23:00-08:00` — set (times are IST by default)\n' +
          '`nh quiet 23:00-08:00 +00:00` — set with a different timezone\n' +
          '`nh quiet` — show the window · `nh quiet off` — clear it',
      },
      {
        name: 'Good to know',
        value:
          '• `mission` and `report` are memory-only — a restart forgets them, run `n cd` to restore\n' +
          '• Reminders land in the channel where the command was run\n' +
          '• `nh off dailies` also stops the pre-reset nudge',
      },
    ],
  },

  feed: {
    title: '🍜 Feed routine',
    description:
      'Saves your daily `n feed` list and ticks lines off as you send them, so you ' +
      'never have to remember where you stopped.\n\n' +
      '**Each ninja can only be fed once per 24h**, so a repeated id is shown as blocked, ' +
      'left out of "still due" and the XP total, and refused on `add`.',
    fields: [
      {
        name: 'Setting it up',
        value:
          'Paste the whole routine in one message:\n' +
          '```\nnh feed set\nn feed 223 rl\nn feed 265 rl\nn feed 152 rm\n```\n' +
          '`n feed` / `feed` prefixes are optional — `223 rl` on its own works too.',
      },
      {
        name: 'Daily use',
        value:
          '`nh feed` — shows ✅ done, ▶️ next, ⬜ pending, and a copyable block of what is left\n' +
          '`nh feed done` — mark everything done without sending them\n' +
          'Lines tick off automatically when you send `n feed <id> <item>`.',
      },
      {
        name: 'Editing',
        value:
          '`nh feed add 223 rl` — append one (refused if that ninja is already listed)\n' +
          '`nh feed remove 4` — remove by position\n' +
          '`nh feed remove 223 rl` — remove by content\n' +
          '`nh feed set <lines>` — replace the whole list\n' +
          '`nh feed clear` — delete it · `nh feed usage` — short syntax reminder',
      },
      {
        name: 'Items',
        value:
          '`rl` Ramen (L) **+5,000 xp**\n' +
          '`rm` Ramen (M) **+2,500 xp**\n' +
          '`rs` Ramen (S) **+1,000 xp**\n' +
          '`bcs` Birthday Cake Slice **+3,000 xp** — also accepts `cake`, `bc`, `slice`',
      },
      {
        name: 'Notes',
        value:
          '• Matching is by ninja id, so feeding `rm` where the routine said `rl` still counts (and says so)\n' +
          '• Progress resets at 00:00 UTC with the dailies\n' +
          '• `nh feed help …` works the same as `nh feed …`',
      },
    ],
  },

  pass: {
    title: '💎 Monthly Pass & digest',
    description:
      'Everything in `n daily` feeds the Monthly Pass — 60 levels a month. The question ' +
      'worth answering is whether you are on pace before the month rolls over.',
    fields: [
      {
        name: 'Commands',
        value:
          '`nh pass` (or `nh monthly`) — level, progress, days left, and the levels/day needed\n' +
          '`nh digest` — yesterday\'s XP, ryo, dailies and feeds\n' +
          'The digest also posts on its own just after each 00:00 UTC reset.',
      },
      {
        name: 'Notes',
        value:
          '• Run `n pass` once so there is something to read\n' +
          '• `nh off digest` stops the automatic post\n' +
          '• The pass page has not been captured yet, so `nh pass` will say plainly ' +
          'which fields it could not read rather than inventing them.',
      },
    ],
  },

  reports: {
    title: '📝 Report helper',
    description:
      '`n r` shows you a fact for 7 seconds, then asks you to pick it out of three ' +
      'near-identical options within 13. Both halves are edits of the same message, so ' +
      'I hold on to the info and tell you which option matches as soon as they appear.',
    fields: [
      {
        name: 'How it reads',
        value:
          '`📝 report → :one:` — all three details matched, safe to pick\n' +
          '`📝 report → probably :two: (2/3 match)` — best guess, check it yourself\n' +
          '`📝 report → couldn\'t tell these apart` — two options scored the same',
      },
      {
        name: 'Notes',
        value:
          '• Nothing to run — it fires on its own during `n r`\n' +
          '• It matches on count, colour and place; all three must agree for a confident answer\n' +
          '• It only reads what the game already showed you. It does not answer for you.',
      },
    ],
  },

  xp: {
    title: '📈 XP & levelling',
    description:
      'XP is read automatically from pages the bot already sends — nothing to arm:\n' +
      '• **training** — "Each ninja gained `3630` xp", plus level and exp for every ninja\n' +
      '• **report results** — "Ninjas in team gained 308 xp"\n' +
      '• **`n t`** — the only page carrying the level-up threshold (e.g. 2046995/**5500000**)',
    fields: [
      {
        name: 'Commands',
        value:
          '`nh xp` — everything: gained since reset, xp/hr, and per-ninja ETA\n' +
          '`nh xp isshiki` — filter to one ninja by name or id',
      },
      {
        name: 'Reading the output',
        value:
          '• **Since reset** — total gained since 00:00 UTC (05:30 IST)\n' +
          '• **Rate** — xp/hr over the last 24h, with a 7-day average alongside\n' +
          '• **ETA** — remaining ÷ current rate, as a countdown\n' +
          'Run `n t` on a ninja to record its level target; without one, only raw xp shows.',
      },
      {
        name: 'Manual sessions',
        value:
          '`nh track xp <id>` then `n t` — locks in a starting value\n' +
          '`nh end track xp <id>` then `n t` — reports gained and xp/hr for that window\n' +
          'Useful for measuring one specific stretch of play. In-memory, so a restart clears it.',
      },
    ],
  },

  dailies: {
    title: '📜 Dailies',
    description:
      'Since the Aug 2026 patch, quests are gone and dailies live under `n daily` — one ' +
      'set per day, auto-claimed, resetting at **00:00 UTC (05:30 IST)**. They are the ' +
      'main Monthly Pass EXP source, so an unfinished set is real value lost.',
    fields: [
      {
        name: 'Commands',
        value: '`nh dailies` — per-task progress bars, the chest bar, and time to reset\n' +
               'Aliases: `nh daily`, `nh d`',
      },
      {
        name: 'The nudge',
        value:
          '**3h before reset** you get a ping listing only what is still open — nothing ' +
          'if you are already done. It survives restarts, and `nh off dailies` stops it.\n' +
          'Run `n d` at least once so there is progress to read.',
      },
    ],
  },

  ryo: {
    title: '💰 Economy',
    description:
      'Ryo movements are recorded as they happen — missions and reports earn, training ' +
      'spends — and paired with your latest `n bal` snapshot.',
    fields: [
      {
        name: 'Commands',
        value: '`nh ryo` — earned/spent since reset and over 24h, broken down by source\n' +
               'Aliases: `nh econ`, `nh economy`, `nh money`',
      },
      {
        name: 'What it tells you',
        value:
          '• Net ryo since reset, and per-run averages by source\n' +
          '• **Training cost per 1,000 xp** — whether a tier is worth it\n' +
          '• What your balance affords: pulls at 300 ryo, special pulls at 500 tickets\n' +
          'Run `n bal` to refresh the balance.',
      },
      {
        name: 'Pull calculator',
        value: 'React 🔢 on any `n bal` page and the bot replies with how many normal and ' +
               'special pulls you can afford right now.',
      },
    ],
  },

  admin: {
    title: '🗄️ Admin',
    description: `Owner only (<@${OWNER_ID}>). Everything here touches the database directly.`,
    fields: [
      {
        name: 'Inspect',
        value: '`nh db stats` — collection counts\n`nh db lookup <userId>` — one user\'s raw record',
      },
      {
        name: 'Clean up',
        value:
          '`nh db clear cooldowns` — wipe all cooldown data\n' +
          '`nh db clear stats` — reset reminder counts\n' +
          '`nh db clear retired` — drop quest/adventure leftovers\n' +
          '`nh db clear user <userId>` — delete one user\n' +
          '`nh db clear inactive` — remove users with no cooldown data\n' +
          '`nh db nuke confirm` — **wipe every user**',
      },
      {
        name: 'Debug capture',
        value:
          'Environment flags, off unless set:\n' +
          '`DEBUG_CAPTURE=all|<channelId>` — dump every message shape\n' +
          '`DEBUG_CAPTURE_FILE=./capture.jsonl` — also append JSONL\n' +
          '`DEBUG_CAPTURE_BOTS=1` — bot messages only\n' +
          '`DEBUG_TRACE=1` — log why each cooldown was armed or dropped',
      },
    ],
  },
};

const ALIASES = {
  reminder: 'reminders', remind: 'reminders', cooldowns: 'reminders', cd: 'reminders',
  status: 'reminders', pause: 'reminders', mute: 'reminders', mutes: 'reminders',
  ramen: 'feed', feeding: 'feed',
  level: 'xp', levels: 'xp', exp: 'xp', eta: 'xp', track: 'xp',
  daily: 'dailies', d: 'dailies',
  econ: 'ryo', economy: 'ryo', money: 'ryo', balance: 'ryo', bal: 'ryo',
  db: 'admin', owner: 'admin', debug: 'admin',
};

const resolveTopic = (raw) => {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return null;
  const name = ALIASES[key] ?? key;
  return TOPICS[name] ? { name, ...TOPICS[name] } : undefined; // undefined = unknown
};

module.exports = { OVERVIEW, TOPICS, resolveTopic, topicNames: Object.keys(TOPICS) };
