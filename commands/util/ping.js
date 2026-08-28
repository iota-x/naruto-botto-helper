// commands/util/ping.js
const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong!'),
  async execute(interaction) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply('Pong!');
    }
  },
};
