const { restoreCooldownsFromDB } = require('./main');

module.exports = {
  // Renamed from 'ready' in discord.js 14.2x; 'ready' is gone in v15.
  name: 'clientReady',
  once: true,
  async execute(client) {
    console.log(`[ready] Logged in as ${client.user.tag}`);
    await restoreCooldownsFromDB(client);
  },
};