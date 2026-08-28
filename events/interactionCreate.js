// events/interactionCreate.js
module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
      if (!interaction.isCommand()) return;
  
      const command = client.commands.get(interaction.commandName);
  
      if (!command) return;
  
      try {
        if (!interaction.deferred && !interaction.replied) {
          await command.execute(interaction);
        } else {
          console.log('Interaction already acknowledged.');
        }
      } catch (error) {
        console.error('Error executing command:', error);
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
        }
      }
    },
  };
  