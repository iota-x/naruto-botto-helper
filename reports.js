// ─── Report answer helper ─────────────────────────────────────────────────────
// `n r` shows you a fact for 7 seconds, then asks you to pick it out of three
// near-identical options within 13. The bot receives both halves — the info page
// and the options are edits of the *same message* — so the match is a pure
// lookup rather than a memory test.
//
//   info:    "a group of 3 suspicious individuals in red clothes in the dango shop"
//   writing: :one:   Reporting 3 suspicious individuals in red in the dango shop
//            :two:   Reporting 3 suspicious individuals in purple in the dango shop
//            :three: Reporting 2 suspicious individuals in purple by the bridge
//
// This only reads what the game already showed you and says which option matches.
// It does not answer for you.

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five',
                      'six', 'seven', 'eight', 'nine', 'ten'];

const P = {
  info:   /group of\s+(\d+)\s+suspicious individuals?\s+in\s+(\S+?)\s+clothes\s+((?:in|by|at|near)\s+the\s+[a-z' ]+?)\s+while/i,
  option: /:(\w+):\s*Reporting\s+(\d+)\s+suspicious individuals?\s+in\s+(\S+?)\s+((?:in|by|at|near)\s+the\s+[a-z' ]+)/gi,
  stageInfo:    /'s report info\b/i,
  stageWriting: /'s report writing\b/i,
  stageResult:  /'s report result\b/i,
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

const parseInfo = (text) => {
  const m = text.match(P.info);
  if (!m) return null;
  return { count: parseInt(m[1], 10), colour: norm(m[2]), place: norm(m[3]) };
};

const parseOptions = (text) => {
  const out = [];
  P.option.lastIndex = 0;
  for (const m of text.matchAll(P.option)) {
    const idx = NUMBER_WORDS.indexOf(m[1].toLowerCase());
    out.push({
      emoji:  m[1],
      index:  idx > 0 ? idx : out.length + 1,
      count:  parseInt(m[2], 10),
      colour: norm(m[3]),
      place:  norm(m[4]),
    });
  }
  return out;
};

/**
 * Score each option against the remembered info. All three attributes must
 * match for a confident answer; anything less is reported as a best guess so a
 * wording change can't quietly hand out wrong answers.
 */
const solve = (info, options) => {
  if (!info || !options?.length) return null;

  const scored = options.map(o => ({
    ...o,
    score: (o.count === info.count ? 1 : 0) +
           (o.colour === info.colour ? 1 : 0) +
           (o.place === info.place ? 1 : 0),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const tied = scored.filter(s => s.score === best.score).length > 1;

  return {
    best,
    exact: best.score === 3 && !tied,
    ambiguous: tied,
    scored,
  };
};

const describe = (o) => `${o.count} ${o.colour}, ${o.place}`;

/** Discord-ready line, or null when there is nothing trustworthy to say. */
const format = (userId, info, options) => {
  const result = solve(info, options);
  if (!result) return null;

  if (result.exact) {
    return `<@${userId}> 📝 report → **:${result.best.emoji}:**  -# ${describe(result.best)}`;
  }
  if (result.ambiguous) {
    return `<@${userId}> 📝 report → couldn't tell these apart — looking for **${describe(info)}**`;
  }
  return `<@${userId}> 📝 report → probably **:${result.best.emoji}:** ` +
         `(${result.best.score}/3 match) -# looking for ${describe(info)}`;
};

module.exports = { parseInfo, parseOptions, solve, format, describe, P };
