const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const Database = require("../../models/user");

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Shows your stats'),
  name: 'stats',
  description: 'Shows your stats',
  /**
   * @param {Interaction} interaction
   */
  async execute(interaction) {
    const userId = interaction.user ? interaction.user.id : interaction.author.id;
    const user = await Database.findOne({ userId });

    if (!user) {
      const noStatsEmbed = new EmbedBuilder()
        .setDescription("There are no stats about you to show.")
        .setColor("Red");

      return interaction.reply ? interaction.reply({ embeds: [noStatsEmbed], ephemeral: true }) : interaction.reply({ embeds: [noStatsEmbed] });
    }

    const stats = {
      mission: user.stats.reminders.mission || 0,
      report: user.stats.reminders.report || 0,
      challenge: user.stats.reminders.challenge || 0,
    };

    const statEmbed = new EmbedBuilder()
      .setTitle("STATS")
      .setColor("Orange")
      .addFields(
        { name: "Mission", value: stats.mission.toLocaleString(), inline: true },
        { name: "Report", value: stats.report.toLocaleString(), inline: true },
        { name: "Challenge", value: stats.challenge.toLocaleString(), inline: true }
      )
      .setFooter({
        text: interaction.user ? interaction.user.tag : interaction.author.tag,
        iconURL: interaction.user ? interaction.user.displayAvatarURL() : interaction.author.displayAvatarURL()
      })
      .setDescription("This command shows your stats!");

    return interaction.reply ? interaction.reply({ embeds: [statEmbed] }) : interaction.reply({ embeds: [statEmbed] });
  },
};
