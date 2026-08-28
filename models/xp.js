const mongoose = require('mongoose');

// Absolute position of one ninja at a point in time — "where am I toward the
// next level". Comes from `n t` (which alone reports the level threshold) and
// from training pages (which report level + exp for the whole team at once).
const XpSampleSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  name:   { type: String, required: true },  // normalised, e.g. "Isshiki Ōtsutsuki"
  unitId: { type: String, default: null },   // only `n t` exposes this
  level:  { type: Number, default: null },
  xp:     { type: Number, required: true },
  needed: { type: Number, default: null },   // only `n t` exposes this
  at:     { type: Date, default: Date.now, expires: '60d' },
});
XpSampleSchema.index({ userId: 1, name: 1, at: -1 });

// A discrete gain — "I earned this much just now". Training and report results
// state the amount outright, so rate and daily totals are exact rather than
// inferred from polling.
const XpEventSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  source: { type: String, required: true },  // train | report | mission | daily_tier
  amount: { type: Number, default: 0 },      // xp gained per ninja
  ryo:    { type: Number, default: 0 },      // ryo earned (+) or spent (−)
  rank:   { type: String, default: null },   // missions only: C | B | A | S | …
  key:    { type: String, default: null },   // dedupe key: message id
  at:     { type: Date, default: Date.now, expires: '60d' },
});
XpEventSchema.index({ userId: 1, at: -1 });
XpEventSchema.index({ key: 1 }, { unique: true, sparse: true });

module.exports = {
  XpSample: mongoose.model('xpsample', XpSampleSchema, 'xpsamples'),
  XpEvent:  mongoose.model('xpevent',  XpEventSchema,  'xpevents'),
};
