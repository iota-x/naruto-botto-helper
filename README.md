# Naruto Botto Helper

*A bot made by @eiota on Discord.*

A Discord companion bot for [Naruto Botto](https://discord.gg/fC6aFSHWF2). It watches the
game bot's own messages and turns them into cooldown reminders, progress tracking, and a
few things the game makes you remember yourself.

Nothing is automated on your behalf — it only reads pages the game already sent you and
tells you what they say.

---

## Why it works the way it does

**A reminder is only set once the game confirms the command actually ran.**

Typing `n m` used to arm a 60-second reminder immediately. Nothing checked whether the game
did anything, so during maintenance you'd get: reminder → retype → maintenance → reminder,
forever.

Now typing a command *arms an intent*. The cooldown is saved only when the reply proves it
worked. Maintenance, errors and "still on cooldown" drop it with one short notice instead;
silence expires harmlessly after 30 seconds.

**Timings come from the game wherever it states one.** Each cooldown carries an *authority* —
`table` (a hardcoded guess) < `derived` (computed) < `stated` (the game told us) — and a
better source is allowed to correct a worse one. Without this the first guess was frozen in
for its whole duration and even `n cd` couldn't fix it.

**Reminders never fire early.** Timers re-check the wall clock before firing and reschedule
if time remains, so a suspended process or a clock jump can't produce a premature ping.

---

## Commands

Everything is prefixed `nh`. `nh help` gives the same list in Discord, with
`nh help <topic>` for detail.

### Reminders

| command | what it does |
| --- | --- |
| `nh status` | every active cooldown, soonest first |
| `nh next` | one view: ready now, feeds due today, what lands soonest, dailies open |
| `nh pause <Xh\|Xm>` / `nh resume` | silence everything for a while |
| `nh off <cmd>` / `nh on <cmd>` / `nh mutes` | silence one reminder |
| `nh quiet 23:00-08:00` | hold overnight pings and deliver them in one summary |

Tracked: `mission` (1m), `report` (10m), `challenge` (30m), `train` (1h), `tower` (6h),
`daily`, `weekly` (7d), and the vote shop offers.

`nh quiet` exists because dailies reset at 00:00 UTC — 05:30 IST — so that reminder lands
overnight. The window **holds** pings rather than dropping them.

### Feed routine

| command | what it does |
| --- | --- |
| `nh feed` | what's still due today, and the next command to send |
| `nh feed set <lines>` | save the whole routine in one paste |
| `nh feed add 223 rl` | append one |
| `nh feed remove 4` / `nh feed remove 223 rl` | remove by position or content |
| `nh feed done` / `nh feed clear` | mark all done / delete |

```
nh feed set
223 rl
265 rl
152 rm
```

Just id and item — the `n feed …` command is built for you. Lines tick off automatically as
you send them, so you never lose your place.

**One item per ninja per 24h is enforced.** A ninja listed twice can never be fed twice, so
the duplicate is shown as blocked, left out of "still due" and out of the XP total, and
refused on `add`. Matching is by ninja id, so feeding an `rm` where the routine said `rl`
still counts (and says so).

Item values: `rl` 5,000 · `rm` 2,500 · `rs` 1,000 · `bcs` 3,000 xp.

### Tracking

| command | what it does |
| --- | --- |
| `nh xp [name]` | gained since reset, xp/hr, and level-up ETA per ninja |
| `nh missions [days]` | mission counts and average ryo by rank |
| `nh ryo` | ryo earned/spent by source, and what your balance affords in pulls |
| `nh dailies` | progress on today's set |
| `nh pass` | Monthly Pass level and the pace needed to finish it |
| `nh streak` | consecutive days with every daily cleared |
| `nh digest` | yesterday's XP, ryo, dailies and feeds |

XP is read from pages you already open — training states the gain and every ninja's level,
report results state the team gain, and `n t` is the only page carrying the level-up
threshold. Together they answer "how much did I gain today" and "how long until this ninja
levels".

### Automatic

- **Report helper** — `n r` shows a fact for 7 seconds, then asks you to pick it out of
  three near-identical options in 13. Both halves are edits of the same message, so the bot
  holds the info and names the match. No mention, so it won't ping you mid-timer.
  `nh off answers` to disable.
- **Jutsu check** — when `n jutsu` asks to confirm, the stated cost is checked against your
  last `n bal`. `nh off jutsu` to disable.
- **Pre-reset last call** — 3h before reset, one message listing everything still open on
  the 24h clock: unfinished dailies *and* unfed ninjas.
- **Daily digest** — posts after each reset with the previous day's totals.
- **Pull calculator** — react 🔢 on any `n bal` page.

### Owner only

`nh db stats` · `nh db lookup <id>` · `nh db clear cooldowns|stats|retired|user <id>|inactive`
· `nh db nuke confirm`

Gated on `OWNER_ID` and fails closed — with nothing configured, nobody is authorised.

---

## Setup

```bash
git clone https://github.com/iota-x/naruto-botto-helper.git
cd naruto-botto-helper
npm install
cp .env.example .env      # then fill it in
node deploy-commands.js   # register slash commands (once)
npm start
```

| variable | purpose |
| --- | --- |
| `DISCORD_TOKEN` | bot token |
| `CLIENT_ID` / `GUILD_ID` | for registering slash commands |
| `MONGO_URI` | MongoDB connection string |
| `OWNER_ID` | Discord user id allowed to run `nh db …` |

Requires Node 16.5+ and a MongoDB database.

---

## Debug capture

Message formats change with game patches, so the bot can record exactly what it receives
rather than leaving you to guess from a screenshot — what Discord *renders* differs from
the payload (`in 10 minutes` is really `<t:…:R>` on the wire).

```bash
DEBUG_CAPTURE=all                    # or a comma-separated list of channel ids
DEBUG_CAPTURE_FILE=./capture.jsonl   # append one JSON object per message
DEBUG_CAPTURE_BOTS=1                 # bot messages only
DEBUG_TRACE=1                        # log why each cooldown was armed or dropped
```

Captures the component tree with type names, flags, embeds, attachments and edits. Inert
unless set, so it's safe to leave wired up.

The trace is the thing to look at when reminders go quiet: `[trace] no match` fires when the
game says something no pattern covers, and prints a preview of the text.

---

## Notes on the game

- **Quests are gone.** The August 2026 patch folded them into `n daily` as auto-claimed
  "dailies" with a 00:00 UTC reset. All quest handling was removed.
- **The bot uses Components V2 for most pages.** `content` is null, `embeds` is empty, and
  the text lives in TextDisplay components — with *no mentions at all*, so pages are
  attributed by the owner name in the header. The migration is partial: `n cd`, `n t` and
  `n bal` still send classic embeds, so both shapes are read.
- **The dailies page carries two different clocks.** `Resets <t:…>` is when the tasks roll
  over; `Claim your Daily reward in 4h 3m` is when the ryo can be claimed. They don't
  coincide, and the reminder follows the claim.

## Structure

```
events/main.js      message routing, cooldown confirmation, commands
events/dbClear.js   owner-only database maintenance
xptracker.js        XP events and snapshots, level-up ETA
feed.js             feed routine and daily progress
dailies.js          dailies parsing and the pre-reset last call
econ.js             ryo flow and balances
pass.js             Monthly Pass
reports.js          report answer matching
jutsu.js            upgrade affordability
quiet.js            quiet hours
digest.js           daily digest and streaks
helptext.js         all in-Discord help content
debug.js            capture and decision tracing
```

## Credits

Made by **@eiota** on Discord.

Not affiliated with Naruto Botto — this is a companion bot that reads the pages the
game already sent you.

## Licence

ISC
