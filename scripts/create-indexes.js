require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/comparateurtn';

async function createIndexes() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  await db.collection('users').createIndexes([
    { key: { email: 1 }, unique: true },
    { key: { username: 1 }, unique: true },
    { key: { emailVerifyToken: 1 }, sparse: true },
    { key: { passwordResetToken: 1 }, sparse: true },
    { key: { createdAt: -1 } }
  ]);

  await db.collection('securitylogs').createIndexes([
    { key: { timestamp: -1 } },
    { key: { userId: 1, timestamp: -1 } },
    { key: { type: 1, timestamp: -1 } }
  ]);

  console.log('Indexes created successfully.');
  await mongoose.connection.close();
}

createIndexes().catch(err => {
  console.error('Error creating indexes:', err);
  process.exit(1);
});
