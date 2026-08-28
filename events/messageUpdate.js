const main = require('./main');

const NARUTO_BOT_ID = '770100332998295572';

// The game bot edits its pages in place rather than sending a follow-up:
//   "report info" → "report writing" → "report result"  (carries the XP gained)
//   "B rank mission"                → + "You earned 256 ryō!"
// Those edits hold the actual outcome, so they have to be routed like a new
// message. Ingestion is idempotent (keyed on message id), so re-processing the
// same page across several edits does not double-count.
module.exports = {
  name: 'messageUpdate',
  once: false,
  async execute(oldMessage, newMessage, client) {
    try {
      if (!newMessage?.author) return;
      if (newMessage.author.id !== NARUTO_BOT_ID) return;
      await main.handleBotMessage(newMessage, client);
    } catch (err) {
      console.error(`[messageUpdate] Unhandled error: ${err.message}`, err);
    }
  },
};
