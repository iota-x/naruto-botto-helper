// ─── Help content ─────────────────────────────────────────────────────────────
// Single source of truth for what the bot does. Kept apart from the command so
// the text is easy to keep in step with the code as features land.

// Configured via OWNER_ID in .env; kept out of the source so a public copy of
// this repo carries nobody's Discord id.
const OWNER_ID = process.env.OWNER_ID || null;

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
      name: '👋 New? — `nh help start`',
      value: 'What this does, what to run first, and how to make it quieter.\n' +
             'Nothing needs setting up — reminders begin on their own.',
    },
    {
      name: '🧭 Right now — `nh next`',
      value: 'One view: what is off cooldown, feeds due today with the exact commands,\n' +
             'what lands soonest, and dailies still open.',
    },
    {
      name: '⏰ Reminders — `nh help reminders`',
      value:
        '`nh status` — every active cooldown, soonest first\n' +
        '`nh pause <Xh|Xm>` · `nh resume` — silence everything for a while\n' +
        '`nh off <cmd>` · `nh on <cmd>` · `nh mutes` — silence one reminder\n' +
        '`nh quiet 23:00-08:00` — hold overnight pings, deliver them together\n' +
        '`nh tz` — pick your timezone from a list so those windows mean what you expect',
    },
    {
      name: '💎 Pass, stats & streaks',
      value:
        '`nh pass` — Monthly Pass level and the pace needed to finish it\n' +
        '`nh missions [days]` — mission counts and ryo by rank\n' +
        '`nh util [24h|week]` — runs taken vs runs the cooldowns allowed\n' +
        '`nh streak` — consecutive days with every daily cleared\n' +
        '`nh digest` — yesterday\'s XP, ryo, dailies and feeds (also posts at reset)',
    },
    {
      name: '🌀 Jutsu upgrades',
      value:
        'When `n jutsu` asks to confirm, I check the cost against your last `n bal`\n' +
        'and say whether you can afford it. `nh off jutsu` turns it off.',
    },
    {
      name: '⚔️ Invasion — `nh help invasion`',
      value:
        'Two sign-up windows a day (09:00 and 21:00 UTC). I ping you when one opens\n' +
        'and again before it shuts, and stop the moment I see you sign.',
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
        'When `n r` asks you to pick the info back out of three options, I repeat the\n' +
        'detail you were shown — you still choose. Automatic, no command.',
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
  start: {
    title: '👋 Getting started',
    description:
      'I watch Naruto Botto in this channel and keep track of your cooldowns, XP, ' +
      'dailies and feeds. I never play for you — I only read what the game already ' +
      'showed you, and tell you when something is ready.\n\n' +
      'You do not have to set anything up. Play as normal and reminders begin on ' +
      'their own. Everything below is optional.',
    fields: [
      {
        name: '1 · Just play',
        value:
          'Run `n m`, `n r`, `n tr` and so on as usual. When the game confirms a ' +
          'command worked, I start a timer and ping you the moment it is ready again.\n' +
          '-# If the game refuses a command — maintenance, still on cooldown — I do ' +
          'not set a reminder, so you never get a false ping.',
      },
      {
        name: '2 · Run `n cd` once',
        value:
          'The cooldown page tells me every timer you already have, so I catch up ' +
          'instantly instead of learning them one at a time.\n' +
          '-# Worth doing again any time you think I have drifted — it always wins ' +
          'over anything I guessed.',
      },
      {
        name: '3 · Your one everyday command: `nh next`',
        value:
          'Shows what is off cooldown right now, feeds still due today with the exact ' +
          'commands to send, what lands soonest, and which dailies are open.\n' +
          '-# If you only ever remember one thing, remember this one.',
      },
      {
        name: '4 · Stop the overnight pings',
        value:
          'Dailies reset at 00:00 UTC, which is the middle of the night in a lot of ' +
          'places.\n' +
          '`nh quiet 23:00-08:00` holds pings during those hours and delivers them ' +
          'in one summary when you wake up — nothing is lost.\n' +
          '-# Those times are read in IST by default. Not where you are? Run ' +
          '`nh tz` once and pick the row showing your current time.',
      },
      {
        name: '5 · If you feed ninjas daily',
        value:
          'Save the routine once and I will tick it off as you go:\n' +
          '```\nnh feed set\n223 rl\n265 rl\n152 rm\n```\n' +
          'Then `nh feed` any time shows what is left and the next command to send.',
      },
      {
        name: 'Want less noise?',
        value:
          '`nh off train` — never remind me about training\n' +
          '`nh pause train 2h` — not for the next couple of hours\n' +
          '`nh pause train 16:00-05:30` — not during these hours, every day\n' +
          '`nh pause 2h` — nothing at all for a while · `nh resume` to undo',
      },
      {
        name: 'Curious how you are doing?',
        value:
          '`nh xp` — gains today, xp/hr, and how long until each ninja levels\n' +
          '`nh util` — how many runs you took vs how many were possible\n' +
          '`nh ryo` · `nh missions` · `nh dailies` · `nh pass` · `nh streak`',
      },
      {
        name: 'Everything else',
        value: '`nh help` lists every command, grouped. `nh help <topic>` goes deeper.',
      },
    ],
  },

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
          '`nh pause train 2h` — mute one reminder for a while\n' +
          '`nh pause train 16:00-05:30` — mute one reminder daily in that window\n' +
          '`nh resume` — unpause early\n' +
          '`nh off mission` — mute one reminder permanently\n' +
          '`nh off all` — mute every reminder\n' +
          '`nh on mission` / `nh on all` — turn back on\n' +
          '`nh mutes` (or `nh toggles`) — list what is currently silenced',
      },
      {
        name: 'Reminders you ignore go quiet by themselves',
        value:
          'You do not have to mute anything to stop being pestered. If three\n' +
          'reminders in a row for one command go unanswered, that reminder rests\n' +
          'on its own and the last one tells you so.\n' +
          '• play a command properly again and its reminder comes back by itself\n' +
          '• `nh on <cmd>` brings it back right away\n' +
          '• `nh mutes` shows anything resting this way\n' +
          'Reminders you *do* act on are never touched — grind away.',
      },
      {
        name: 'Quiet hours',
        value:
          'Dailies reset at 00:00 UTC, so that reminder lands overnight for many people. ' +
          'A quiet window **holds** pings rather than dropping them and delivers one ' +
          'summary when it ends.\n' +
          '`nh quiet 23:00-08:00` — set · `nh quiet` — show · `nh quiet off` — clear',
      },
      {
        name: 'Your timezone',
        value:
          'Every window above is a wall-clock time, so it needs a timezone. The default ' +
          'is IST because most of this server plays from India — if that is not you, ' +
          'set your own once and every window follows it.\n' +
          '**`nh tz`** — opens a picker; choose the row showing **your current time**, ' +
          'no zone names to look up\n' +
          '`nh tz Europe/Berlin` · `nh tz +02:00` — if you would rather type it\n' +
          '`nh tz off` — back to the default\n' +
          '-# A zone name follows daylight saving on its own; a fixed offset goes an ' +
          'hour wrong at the changeover. Setting your timezone also re-reads any quiet ' +
          'hours you already have, so the times you typed keep their meaning.',
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
          '```\nnh feed set\n223 rl\n265 rl\n152 rm\n```\n' +
          'Just id and item — I build the `n feed …` command for you. ' +
          'Pasting a full `n feed 223 rl` also works, so you can copy an existing routine straight in.',
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
          '• Run `n pass` once so there is something to read; level-ups update it too\n' +
          '• `nh off digest` stops the automatic post\n' +
          '• 60 levels a month for everyone — Deluxe/Ultra multiply the *rewards*, ' +
          'not the level count, and the page names all three tiers to everybody, ' +
          'so which one you own is not inferred from it.',
      },
    ],
  },

  reports: {
    title: '📝 Report helper',
    description:
      '`n r` shows you a fact for 7 seconds, then asks you to pick it out of three ' +
      'near-identical options within 13. Both halves are edits of the same message, so ' +
      'I hold on to the detail and repeat it back when the options appear.\n\n' +
      '**I do not tell you which button to press.** That would be answering for you, ' +
      'which the game does not allow. You still read the options and choose.',
    fields: [
      {
        name: 'What you see',
        value:
          '`📝 **you** report → **3 red, in the dango shop**`\n' +
          'That is the detail from the info page, held for you through the 7-second ' +
          'window so you are not relying on memory when the options appear.',
      },
      {
        name: 'Notes',
        value:
          '• Nothing to run — it fires on its own during `n r`\n' +
          '• No mention, so it will not ping you mid-timer\n' +
          '• `nh off answers` turns it off · `nh on answers` back on\n' +
          '  (that is separate from `nh off report`, which mutes the 10-minute reminder)\n' +
          '• It only repeats what the game already showed you, and never picks for you.',
      },
      {
        name: 'Admins: allowing the full answer',
        value:
          'In a channel you explicitly allow, it can also name the option to click:\n' +
          '`nh whitelist` — show which channels are allowed\n' +
          '`nh whitelist here` — allow it in this channel\n' +
          '`nh whitelist <channel id>` — allow it somewhere else\n' +
          '`nh whitelist remove here` — back to detail only\n' +
          '-# off everywhere by default · needs Manage Server or higher',
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
        value: '`nh ryo` — today: ryo earned, spent, net, and xp gained — plus a source breakdown\n' +
               'Aliases: `nh econ`, `nh economy`, `nh money`',
      },
      {
        name: 'What it tells you',
        value:
          '• **Today** — ryo earned, ryo spent, net, and total xp gained since the ' +
          '00:00 UTC reset\n' +
          '• **Rolling 24h** — the same over a moving window ending now. It reaches ' +
          'back into yesterday, so it will not match "Today" and is not meant to\n' +
          '• Per-run averages by source (mission, report, train)\n' +
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

  invasion: {
    title: '⚔️ Invasion',
    body:
      'The Ōtsutsuki clan invades every day. You sign your ninja list in defence during ' +
      'one of two windows, and the invasion resolves after 22:00 UTC.',
    fields: [
      {
        name: 'The two windows',
        value:
          '`09:00–09:45 UTC` — 14:30 IST\n' +
          '`21:00–21:45 UTC` — 02:30 IST\n' +
          'Both feed the **same** invasion — two chances to sign, not two rewards.',
      },
      {
        name: 'Signing',
        value:
          '`n invasion sign` (or `n i s`) — signs with your current `n list` power\n' +
          'You may sign up to three times, but a re-sign only **refreshes** your power — ' +
          'it does not stack. One sign is enough.\n' +
          '-# Power is read at the moment you sign, so a later sign-up reflects a ' +
          'fuller day of training.',
      },
      {
        name: 'What the helper does',
        value:
          '• pings you when a window opens, and once more ~10 min before it shuts\n' +
          '• both reminders stop for the day the moment it sees you sign\n' +
          '• `nh next` shows whether you are signed, and the power you signed with\n' +
          '• `nh off invasion` silences it · `nh on invasion` brings it back\n' +
          '-# The 02:30 IST window is skipped rather than held if it falls inside your ' +
          'quiet hours — a ping delivered after the window shut would be no use.',
      },
      {
        name: 'Rewards',
        value:
          'Ryo scales with your total list power, from 1500 (≤1mil) to 6500 (3mil+). ' +
          'Five MVPs also receive a **Chakra Fruit**, and the higher your list power the ' +
          'better your chance. Weekly missions and players challenged both add bonus ' +
          'power on top — see `n invasion` in-game for the table.',
      },
    ],
  },

  admin: {
    title: '🗄️ Admin',
    description: `Owner only${OWNER_ID ? ` (<@${OWNER_ID}>)` : ''}. Everything here touches the database directly.`,
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
  getstarted: 'start', 'get-started': 'start', begin: 'start', intro: 'start',
  tutorial: 'start', guide: 'start', setup: 'start', new: 'start', first: 'start',
  basics: 'start', how: 'start',
  reminder: 'reminders', remind: 'reminders', cooldowns: 'reminders', cd: 'reminders',
  status: 'reminders', pause: 'reminders', mute: 'reminders', mutes: 'reminders',
  tz: 'reminders', timezone: 'reminders', quiet: 'reminders',
  sign: 'invasion', i: 'invasion',
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
