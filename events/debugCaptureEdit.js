const { capture } = require('../debug');

// The game bot edits pages in place — a mission embed gains "You earned 256 ryō!"
// once you answer. Those edits carry the real outcome, so capture them too.
module.exports = {
  name: 'messageUpdate',
  once: false,
  async execute(_oldMessage, newMessage) {
    capture(newMessage, 'edit');
  },
};
