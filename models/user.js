const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  userId: String,
  disabled: {
    mission:   { default: false, type: Boolean },
    report:    { default: false, type: Boolean },
    challenge: { default: false, type: Boolean },
    tower:     { default: false, type: Boolean },
    adventure: { default: false, type: Boolean },
  },
  stats: {
    reminders: {
      mission:   { default: 0, type: Number },
      report:    { default: 0, type: Number },
      challenge: { default: 0, type: Number },
      tower:     { default: 0, type: Number },
      quest:     { default: 0, type: Number },
      daily:     { default: 0, type: Number },
      weekly:    { default: 0, type: Number },
    },
  },
  cooldowns: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
});

module.exports = mongoose.model("user", UserSchema, "user");