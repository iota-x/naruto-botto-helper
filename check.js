// check.js at root
require('dotenv').config();
const mongoose = require('mongoose');

mongoose.set('strictQuery', true);

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;

  // List all collections
  const collections = await db.listCollections().toArray();
  console.log('Collections found:', collections.map(c => c.name));

  // Count docs in each
  for (const col of collections) {
    const count = await db.collection(col.name).countDocuments();
    const sample = await db.collection(col.name).findOne();
    console.log(`\n── ${col.name} (${count} docs) ──`);
    console.log(JSON.stringify(sample, null, 2));
  }

  process.exit(0);
}).catch(err => {
  console.error('Connection error:', err.message);
  process.exit(1);
});