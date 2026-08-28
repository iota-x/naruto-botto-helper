const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { OVERVIEW, resolveTopic, topicNames } = require('../../helptext');

// Discord caps an embed at 6000 characters and each field value at 1024, so a
// long topic is split across continuation fields rather than silently truncated.
const FIELD_LIMIT = 1024;

const addField = (embed, name, value) => {
  const chunks = [];
  let rest = value;
  while (rest.length > FIELD_LIMIT) {
    let cut = rest.lastIndexOf('\n', FIELD_LIMIT);
    if (cut <= 0) cut = FIELD_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  chunks.push(rest);
  chunks.forEach((c, i) => embed.addFields({ name: i === 0 ? name : '​', value: c }));
};

const build = (spec, user, client, footerOverride) => {
  const embed = new EmbedBuilder()
    .setTitle(spec.title)
    .setDescription(spec.description)
    .setColor('Green');

  for (const f of spec.fields) addField(embed, f.name, f.value);

  // setFooter/setThumbnail throw on a malformed URL, which would take the whole
  // help command down. Only pass one through if it actually parses.
  const asUrl = (v) => {
    try { return v && /^https?:/.test(v) && new URL(v) ? v : null; }
    catch { return null; }
  };

  const footerText = footerOverride ?? spec.footer
    ?? (user ? `Requested by ${user.tag ?? user.username}` : null);
  if (footerText) {
    const icon = asUrl(user?.displayAvatarURL?.());
    embed.setFooter(icon ? { text: footerText, iconURL: icon } : { text: footerText });
  }

  const thumb = asUrl(client?.user?.displayAvatarURL?.());
  if (thumb) embed.setThumbnail(thumb);
  return embed;
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Explains every command the reminder bot has')
    .addStringOption(o =>
      o.setName('topic')
       .setDescription('reminders, feed, xp, dailies, ryo, admin')
       .setRequired(false)),

  /**
   * Works for both a slash interaction and an `nh help <topic>` message —
   * the message dispatcher calls this with (message, args).
   */
  async execute(ctx, args = []) {
    const user   = ctx.user ?? ctx.author;
    const client = ctx.client;

    const requested = ctx.options?.getString?.('topic') ?? args[0] ?? null;
    const topic = resolveTopic(requested);

    // resolveTopic: null = none asked for, undefined = asked for something unknown
    if (topic === undefined) {
      const embed = build(OVERVIEW, user, client,
        `"${requested}" isn't a topic — try: ${topicNames.join(', ')}`);
      return ctx.reply({ embeds: [embed] });
    }

    const spec = topic ?? OVERVIEW;
    const footer = topic ? `nh help — back to the full list` : undefined;
    return ctx.reply({ embeds: [build(spec, user, client, footer)] });
  },
};
