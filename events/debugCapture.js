const { capture } = require('../debug');

module.exports = {
  name: 'messageCreate',
  once: false,
  async execute(message) {
    capture(message, 'create');
  },
};
