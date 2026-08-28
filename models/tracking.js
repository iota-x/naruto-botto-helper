const mongoose = require('mongoose');

// Latest observed state of a user's dailies page. Kept as snapshots rather than
// a single mutable row so progress over the day stays inspectable.
const DailiesSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  channelId:  { type: String, default: null },
  tasks:      [{ label: String, done: Number, total: Number, reward: String, _id: false }],
  chestDone:  { type: Number, default: null },
  chestTotal: { type: Number, default: null },
  resetAt:    { type: Date,   default: null },
  at:         { type: Date,   default: Date.now, expires: '14d' },
});
DailiesSchema.index({ userId: 1, at: -1 });

// `n bal` snapshots — lets us say "you can afford N pulls" and chart ryo over time.
const BalanceSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  ryo:        { type: Number, default: null },
  special:    { type: Number, default: null },
  weapon:     { type: Number, default: null },
  chakra:     { type: Number, default: null },
  vote:       { type: Number, default: null },
  premium:    { type: Number, default: null },
  extraction: { type: Number, default: null },
  at:         { type: Date,   default: Date.now, expires: '60d' },
});
BalanceSchema.index({ userId: 1, at: -1 });

// A saved `n feed` routine — the same ninjas fed the same items every day.
// Order matters and duplicates are legitimate (the same ninja can be fed twice),
// so this is an ordered list, not a set.
const FeedRoutineSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true },
  entries:   [{ unitId: String, item: String, _id: false }],
  updatedAt: { type: Date, default: Date.now },
});

// One row per observed `n feed`, so progress survives restarts. Keyed on the
// triggering message id so a re-read can't double-count.
const FeedLogSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  unitId: { type: String, required: true },
  item:   { type: String, required: true },
  key:    { type: String, default: null },
  at:     { type: Date, default: Date.now, expires: '14d' },
});
FeedLogSchema.index({ userId: 1, at: -1 });
FeedLogSchema.index({ key: 1 }, { unique: true, sparse: true });

// One row per user per day, written at the reset. Kept separate from the
// snapshots (which expire in 14 days) so streak history survives long term.
const DailyResultSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  day:        { type: String, required: true },   // YYYY-MM-DD of the day that ended, UTC
  completed:  { type: Boolean, default: false },
  tasksDone:  { type: Number, default: 0 },
  tasksTotal: { type: Number, default: 0 },
  xp:         { type: Number, default: 0 },
  ryo:        { type: Number, default: 0 },
  feeds:      { type: Number, default: 0 },
  at:         { type: Date, default: Date.now },
});
DailyResultSchema.index({ userId: 1, day: -1 }, { unique: true });

module.exports = {
  DailyResult: mongoose.model('dailyresult', DailyResultSchema, 'dailyresults'),
  Dailies:     mongoose.model('dailies', DailiesSchema, 'dailies'),
  Balance:     mongoose.model('balance', BalanceSchema, 'balances'),
  FeedRoutine: mongoose.model('feedroutine', FeedRoutineSchema, 'feedroutines'),
  FeedLog:     mongoose.model('feedlog', FeedLogSchema, 'feedlogs'),
};
