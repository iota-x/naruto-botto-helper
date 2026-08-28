const mongoose = require('mongoose');

const RemindSchema = new mongoose.Schema({
  userId: String,
  mission: { type: Number, default: 0 },
  report: { type: Number, default: 0 },
  tower: { type: Number, default: 0 },
  quest: { type: Number, default: 0 },
  challenge: { type: Number, default: 0 },
  daily: { type: Number, default: 0 },
  weekly: { type: Number, default: 0 },
  reminded: {
    mission: { type: Boolean, default: false },
    report: { type: Boolean, default: false },
    tower: { type: Boolean, default: false },
    quest: { type: Boolean, default: false },
    challenge: { type: Boolean, default: false },
    daily: { type: Boolean, default: false },
    weekly: { type: Boolean, default: false },
  },
});

module.exports = mongoose.model('reminders', RemindSchema);
