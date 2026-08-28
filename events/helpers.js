const { Message, EmbedBuilder } = require("discord.js");

/**
 * Handles balance reaction and replies with calculated pulls.
 * @param {Message} message - The original message.
 */
async function handleBalanceReaction(message) {
  try {
    if (!message.author.bot) return;
    if (message.author.id !== "770100332998295572") return;
    if (!message.embeds[0] || !message.embeds[0].title) return;

    const title = message.embeds[0].title;
    if (!title.includes("balance")) return;

    await message.react("🔢");

    // Slight delay to ensure the reaction is registered
    setTimeout(() => {
      const filter = (reaction, user) => reaction.emoji.name === "🔢" && !user.bot;

      const collector = message.createReactionCollector({ filter, max: 1, time: 60000 });

      collector.on("collect", async (reaction, user) => {
        const embedDescription = message.embeds[0].description;

        if (!embedDescription) {
          return;
        }

        // Update the regex patterns to match the actual format of the embed description
        const ryoMatch = embedDescription.match(/\*\*Ryō:\*\*\s*([\d,]+)/);
        const tixMatch = embedDescription.match(/\*\*Special tickets:\*\*\s*([\d,]+)/);

        if (!ryoMatch || !tixMatch) {
          return;
        }

        const ryo = parseInt(ryoMatch[1].replace(/,/g, ''), 10);
        const tix = parseInt(tixMatch[1].replace(/,/g, ''), 10);

        const embed = new EmbedBuilder()
          .setTitle("Balance")
          .setDescription("**This is what you can do with your balance:**")
          .addFields(
            { name: "Pulls", value: Math.floor(ryo / 300).toLocaleString(), inline: true },
            { name: "Special pulls", value: Math.floor(tix / 500).toLocaleString(), inline: true }
          )
          .setColor("#FFD700") // Use hexadecimal color code for gold
          .setFooter({ text: message.embeds[0].title });

        try {
          await message.reply({ embeds: [embed] });
        } catch (error) {
          console.error("Failed to send reply:", error);
        }
      });

      collector.on("end", collected => {
        // No action needed on end
      });
    }, 1000); // 1-second delay
  } catch (error) {
    console.error("Error handling balance reaction:", error);
  }
}

module.exports = { handleBalanceReaction };
