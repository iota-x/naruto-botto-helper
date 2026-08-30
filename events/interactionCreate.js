// events/interactionCreate.js
const main = require('./main');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction, client) {
    try {
      // Message components (the timezone picker) arrive here too, and are not
      // commands — route them first or they fall through and do nothing.
      if (interaction.isMessageComponent?.()) {
        await main.handleComponent(interaction, client);
        return;
      }

      if (!interaction.isCommand()) return;

      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      if (!interaction.deferred && !interaction.replied) {
        await command.execute(interaction);
      } else {
        console.log('Interaction already acknowledged.');
      }
    } catch (error) {
      console.error('Error handling interaction:', error);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({
          content: 'There was an error while handling that.',
          ephemeral: true,
        }).catch(() => {});
      }
    }
  },
};
