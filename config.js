// ─── Who this helper listens to ───────────────────────────────────────────────
// One game bot, and nothing else. Every reminder, cooldown correction, XP record
// and page parse is gated on this id — a message from any other bot in the
// channel is ignored outright, however closely it resembles a Naruto Botto page.
//
// It lived in four separate files before, which is four chances to drift. Change
// it here, or set GAME_BOT_ID in .env to point at a different bot.

const GAME_BOT_ID = process.env.GAME_BOT_ID || '770100332998295572'; // Naruto Botto

// ─── Report helper mode ───────────────────────────────────────────────────────
// By default the report helper repeats the detail you were shown — "3 red, in
// the dango shop" — and stops there. It does not say which option to click.
// Naming the button is answering for you, which the game bot's rules do not
// allow, so it is off everywhere unless a channel is listed here.
//
// Set REPORT_ANSWER_CHANNELS to a comma-separated list of channel ids to allow
// the full answer in those channels only.
const REPORT_ANSWER_CHANNELS = new Set(
  (process.env.REPORT_ANSWER_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const mayShowReportOption = (channelId) => REPORT_ANSWER_CHANNELS.has(channelId);

module.exports = {
  GAME_BOT_ID, REPORT_ANSWER_CHANNELS, mayShowReportOption,
};
