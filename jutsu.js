// ─── Jutsu upgrade check ──────────────────────────────────────────────────────
// `n jutsu` asks for a yes/no before spending, and the prompt states the cost:
//
//   Do you want to increase Isshiki Ōtsutsuki - Celestial Being (ID: 223) Jutsu
//   level from 46 to 47 in cost of 2912 chakra tickets and 14562 special
//   tickets **eiota?** Confirm with `yes/y`. Cancel with `no/n`.
//
// Held against the latest `n bal` snapshot, that becomes a straight
// can-I-afford-this answer while the prompt is still open.

const { Balance } = require('./models/tracking');

const num = (s) => parseInt(String(s).replace(/[,\s]/g, ''), 10);
const fmt = (n) => Number(n).toLocaleString('en-US');

const P = {
  prompt: /do you want to increase\s+(.+?)\s*\(ID:\s*(\d+)\)\s*jutsu level from\s*(\d+)\s*to\s*(\d+)/i,
  chakra: /([\d,]+)\s*chakra tickets?/i,
  special: /([\d,]+)\s*special tickets?/i,
  // This page has no "X's …" header; it addresses the user at the end,
  // "… special tickets **eiota?**", so the name comes from there instead.
  who: /\*\*([^*\n]+?)\?\*\*/,
};

const parse = (text) => {
  const m = text.match(P.prompt);
  if (!m) return null;
  const chakra  = text.match(P.chakra);
  const special = text.match(P.special);
  const who     = text.match(P.who);
  return {
    name:    m[1].trim(),
    unitId:  m[2],
    from:    num(m[3]),
    to:      num(m[4]),
    chakra:  chakra ? num(chakra[1]) : 0,
    special: special ? num(special[1]) : 0,
    user:    who ? who[1].trim() : null,
  };
};

/**
 * Discord-ready verdict, or null when there's no balance to compare against.
 * No mention: the prompt has a live yes/no waiting, so a ping is just noise.
 */
const check = async (userId, upgrade, label) => {
  const bal = await Balance.findOne({ userId }).sort({ at: -1 }).lean();
  const who = label ? `**${label}** ` : '';

  const cost = [
    upgrade.chakra  ? `${fmt(upgrade.chakra)} chakra` : null,
    upgrade.special ? `${fmt(upgrade.special)} special` : null,
  ].filter(Boolean).join(' + ');

  const head = `🌀 ${who}jutsu **${upgrade.from} → ${upgrade.to}** on ${upgrade.name} · ${cost}`;

  if (!bal) {
    return `${head}\n-# run \`n bal\` once and I can tell you whether you can afford these`;
  }

  const shortfalls = [];
  if (upgrade.chakra  > (bal.chakra  ?? 0)) shortfalls.push(`**${fmt(upgrade.chakra  - (bal.chakra  ?? 0))}** chakra`);
  if (upgrade.special > (bal.special ?? 0)) shortfalls.push(`**${fmt(upgrade.special - (bal.special ?? 0))}** special`);

  if (shortfalls.length) {
    return `${head}\n❌ short by ${shortfalls.join(' and ')} — balance read <t:${Math.floor(new Date(bal.at).getTime() / 1000)}:R>`;
  }

  const after = [
    upgrade.chakra  ? `${fmt((bal.chakra  ?? 0) - upgrade.chakra)} chakra` : null,
    upgrade.special ? `${fmt((bal.special ?? 0) - upgrade.special)} special` : null,
  ].filter(Boolean).join(', ');

  return `${head}\n✅ affordable — leaves ${after}` +
         `\n-# balance read <t:${Math.floor(new Date(bal.at).getTime() / 1000)}:R>, \`n bal\` to refresh`;
};

module.exports = { parse, check, P };
