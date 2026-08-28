const database = require("../models/user");

const AUTHORIZED_ID = '000000000000000000';

module.exports = {
  name: "messageCreate",
  once: false,
  async execute(message, client) {
    if (message.author.id !== AUTHORIZED_ID) return;
    if (message.author.bot) return;

    const lower = message.content.trim().toLowerCase();
    if (!lower.startsWith('nh db')) return;

    const args = lower.slice(5).trim().split(/ +/);
    const sub  = args[0];

    try {
      switch (sub) {

        // ── nh db stats ─────────────────────────────────────────────────────
        case 'stats': {
          const total         = await database.countDocuments({});
          const withCooldowns = await database.countDocuments({ cooldowns: { $exists: true, $ne: {} } });
          const inactive      = await database.countDocuments({ cooldowns: { $exists: false } });
          await message.channel.send(
            `📊 **DB Stats**\n` +
            `> Total users: **${total}**\n` +
            `> With cooldowns: **${withCooldowns}**\n` +
            `> No cooldown data: **${inactive}**`
          );
          break;
        }

        // ── nh db clear cooldowns ───────────────────────────────────────────
        case 'clear': {
          const target = args[1];

          if (target === 'cooldowns') {
            const result = await database.updateMany({}, { $unset: { cooldowns: '' } });
            await message.channel.send(`🧹 Cleared cooldowns for **${result.modifiedCount}** users.`);

          } else if (target === 'stats') {
            const result = await database.updateMany({}, {
              $set: {
                'stats.reminders.mission':   0,
                'stats.reminders.report':    0,
                'stats.reminders.challenge': 0,
                'stats.reminders.train':     0,
                'stats.reminders.tower':     0,
                'stats.reminders.daily':     0,
                'stats.reminders.weekly':    0,
                'stats.reminders.buy_v15':   0,
                'stats.reminders.buy_v20':   0,
              }
            });
            await message.channel.send(`🧹 Reset stats for **${result.modifiedCount}** users.`);

          } else if (target === 'user') {
            const targetId = args[2];
            if (!targetId) return message.channel.send('❌ Usage: `nh db clear user <userId>`');
            const result = await database.deleteOne({ userId: targetId });
            await message.channel.send(
              result.deletedCount
                ? `🗑️ Deleted user **${targetId}**.`
                : `⚠️ No user found with ID **${targetId}**.`
            );

          } else if (target === 'inactive') {
            const result = await database.deleteMany({ cooldowns: { $exists: false } });
            await message.channel.send(`🗑️ Removed **${result.deletedCount}** inactive users.`);

          } else if (target === 'retired') {
            // Aug 2026: quests folded into `n daily`. Old rows still carry
            // cooldowns.quest — restore already skips them, this clears them out.
            const result = await database.updateMany({}, {
              $unset: {
                'cooldowns.quest':          '',
                'cooldowns.quests':         '',
                'cooldowns.adventure':      '',
                'stats.reminders.quest':    '',
              }
            });
            await message.channel.send(`🧹 Purged retired cooldowns from **${result.modifiedCount}** users.`);

          } else {
            await message.channel.send(
              `❌ Unknown target. Options:\n` +
              `> \`nh db clear cooldowns\` — wipe all cooldown data\n` +
              `> \`nh db clear stats\` — reset all reminder counts\n` +
              `> \`nh db clear retired\` — drop quest/adventure leftovers\n` +
              `> \`nh db clear user <userId>\` — delete one user\n` +
              `> \`nh db clear inactive\` — remove users with no cooldown data`
            );
          }
          break;
        }

        // ── nh db lookup <userId> ───────────────────────────────────────────
        case 'lookup': {
          const targetId = args[1];
          if (!targetId) return message.channel.send('❌ Usage: `nh db lookup <userId>`');
          const user = await database.findOne({ userId: targetId }).lean();
          if (!user) return message.channel.send(`⚠️ No user found with ID **${targetId}**.`);
          const text = JSON.stringify(user, null, 2);
          await message.channel.send(`\`\`\`json\n${text.slice(0, 1900)}\n\`\`\``);
          break;
        }

        // ── nh db nuke ──────────────────────────────────────────────────────
        case 'nuke': {
          if (args[1] !== 'confirm') {
            const count = await database.countDocuments({});
            return message.channel.send(
              `⚠️ This will delete **all ${count} users** from the DB.\n` +
              `Type \`nh db nuke confirm\` to proceed.`
            );
          }
          const result = await database.deleteMany({});
          await message.channel.send(`💥 Nuked **${result.deletedCount}** users from the DB.`);
          break;
        }

        // ── nh db help ──────────────────────────────────────────────────────
        default: {
          await message.channel.send(
            `📋 **DB Commands**\n` +
            `> \`nh db stats\` — collection counts\n` +
            `> \`nh db clear cooldowns\` — wipe all cooldown data\n` +
            `> \`nh db clear stats\` — reset reminder counts to 0\n` +
            `> \`nh db clear retired\` — drop quest/adventure leftovers\n` +
            `> \`nh db clear user <userId>\` — delete one user\n` +
            `> \`nh db clear inactive\` — remove users with no cooldown data\n` +
            `> \`nh db lookup <userId>\` — inspect a user's raw data\n` +
            `> \`nh db nuke confirm\` — wipe entire DB`
          );
        }
      }
    } catch (err) {
      console.error('[dbClear] Error:', err);
      await message.channel.send(`❌ Error: ${err.message}`);
    }
  },
};