const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Provides information about the reminder bot'),
  async execute(interaction) {
    const helpEmbed = new EmbedBuilder()
      .setTitle('❓ Help')
      .setDescription(
        'I watch Naruto Botto and set cooldown reminders — but only once the bot ' +
        'confirms your command actually ran. Maintenance, errors and cooldown ' +
        'refusals no longer arm a reminder.'
      )
      .addFields(
        { name: '⏰ Reminders', value: '`nh status` · `nh pause <Xh|Xm>` · `nh resume`\n`nh off <cmd>` / `nh on <cmd>` · `nh mutes`' },
        { name: '🍜 Feed routine', value: '`nh feed` — what\'s left today\n`nh feed set <lines>` · `nh feed add 223 rl` · `nh feed remove 4`' },
        { name: '📜 Dailies & ryo', value: '`nh dailies` — progress + pre-reset nudge\n`nh ryo` — earned/spent and what your balance affords' },
        { name: '📈 XP', value: '`nh xp` — gains since reset, rate, level-up ETA\n`nh xp <name>` — one ninja\n`nh track xp <id>` · `nh end track xp <id>` — manual session' },
        { name: '📊 Stats', value: '`stats`' },
        { name: '⚙️ Utility', value: '`help` & `ping`', inline: false },
        { name: '📜 Dailies', value: 'Quests are gone — they live under `n daily` now and reset at **00:00 UTC** (05:30 IST).' }
      )
      .setFooter({
        text: interaction.user ? interaction.user.tag : interaction.author.tag,
        iconURL: interaction.user ? interaction.user.displayAvatarURL() : interaction.author.displayAvatarURL()
      })
      .setColor('Green')
      .setThumbnail(interaction.client.user.displayAvatarURL());

    await interaction.reply({ embeds: [helpEmbed] });
  },
};
