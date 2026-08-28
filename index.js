const fs = require('fs');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const mongoose = require('mongoose');
require('dotenv').config();

const { handleBalanceReaction } = require('./events/helpers');

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

client.commands = new Collection();

// ─── Load commands ────────────────────────────────────────────────────────────

for (const folder of fs.readdirSync('./commands')) {
  for (const file of fs.readdirSync(`./commands/${folder}`).filter(f => f.endsWith('.js'))) {
    const command = require(`./commands/${folder}/${file}`);
    const cmdName = command.data?.name ?? command.name; // support both styles
    if (cmdName) {
      client.commands.set(cmdName, command);
    } else {
      console.warn(`[commands] Missing name in ./commands/${folder}/${file}`);
    }
  }
}

// ─── Load events ─────────────────────────────────────────────────────────────

for (const file of fs.readdirSync('./events').filter(f => f.endsWith('.js'))) {
  const event = require(`./events/${file}`);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

// ─── Balance reaction listener ────────────────────────────────────────────────

client.on('messageCreate', async message => {
  await handleBalanceReaction(message);
});

// ─── Crash resilience ─────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ─── MongoDB ──────────────────────────────────────────────────────────────────

mongoose.set('strictQuery', true);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser:          true,
      useUnifiedTopology:       true,
      serverSelectionTimeoutMS: 10_000,
    });
    console.log('[db] Connected to MongoDB.');
  } catch (err) {
    console.error('[db] Failed to connect:', err.message);
    console.log('[db] Retrying in 10s...');
    setTimeout(connectDB, 10_000);
  }
};

connectDB();

// ─── Discord login with retry ─────────────────────────────────────────────────

const connectDiscord = async (attempt = 1) => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log('[login] Connected to Discord!');
  } catch (err) {
    const delay = Math.min(attempt * 5_000, 60_000); // 5s, 10s, 15s ... capped at 60s
    console.error(`[login] Failed (attempt ${attempt}): ${err.message}`);
    console.log(`[login] Retrying in ${delay / 1000}s...`);
    setTimeout(() => connectDiscord(attempt + 1), delay);
  }
};

// Handle disconnects after initial login
client.on('shardDisconnect', (event, shardId) => {
  console.warn(`[discord] Shard ${shardId} disconnected (code ${event.code}). Discord.js will auto-reconnect.`);
});

client.on('shardError', (err) => {
  console.error('[discord] Shard error:', err.message);
});

client.on('shardReconnecting', (shardId) => {
  console.log(`[discord] Shard ${shardId} reconnecting...`);
});

client.on('shardResume', (shardId) => {
  console.log(`[discord] Shard ${shardId} resumed.`);
});

connectDiscord();