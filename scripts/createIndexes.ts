/**
 * Run after loading data:
 *   npx ts-node scripts/createIndexes.ts
 *
 * Creates candle + compound indexes on all option_chain_*_* collections.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { INSTRUMENTS, Instrument } from '../src/types';

const YEARS = [2020, 2021, 2022, 2023, 2024, 2025];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/algo_backtest');
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db!;
  const collections = await db.listCollections().toArray();
  const existingNames = new Set(collections.map(c => c.name));

  let created = 0;
  for (const instrument of INSTRUMENTS) {
    for (const year of YEARS) {
      const name = `option_chain_${instrument.toLowerCase()}_${year}`;
      if (!existingNames.has(name)) continue;

      const col = db.collection(name);

      await col.createIndex({ candle: 1 },             { background: true });
      await col.createIndex({ candle: 1, underlying: 1 }, { background: true });

      const count = await col.countDocuments();
      console.log(`✓ ${name}: indexes created (${count.toLocaleString()} docs)`);
      created++;
    }
  }

  if (created === 0) console.log('No option_chain collections found — nothing to index.');
  else console.log(`\nDone. Indexed ${created} collection(s).`);

  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
