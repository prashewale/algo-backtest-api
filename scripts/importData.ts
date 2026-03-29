/**
 * Data import utility.
 * Loads raw option chain JSON files into the correct MongoDB collections.
 *
 * Supported input formats:
 *   1. Single document JSON:  { candle, underlying, options, ... }
 *   2. Array of documents:    [{ candle, ... }, { candle, ... }]
 *   3. NDJSON (newline-delimited JSON): one document per line
 *
 * Usage:
 *   npx ts-node scripts/importData.ts --file ./data/nifty_2024_jan.json
 *   npx ts-node scripts/importData.ts --dir  ./data/nifty_2024/
 *   npx ts-node scripts/importData.ts --file ./data/sample.json --dry-run
 *
 * The script detects the instrument and year from the document content
 * and routes each document to option_chain_{instrument}_{year}.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import mongoose from 'mongoose';
import { getOptionChainModel } from '../src/models';
import { Instrument, INSTRUMENTS } from '../src/types';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args[args.indexOf('--file') + 1];
const dirPath  = args[args.indexOf('--dir')  + 1];
const dryRun   = args.includes('--dry-run');
const batchSize = parseInt(args[args.indexOf('--batch') + 1] ?? '500') || 500;

if (!filePath && !dirPath) {
  console.error('Usage: ts-node scripts/importData.ts --file <path> | --dir <dir> [--dry-run] [--batch 500]');
  process.exit(1);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

const stats = {
  total:     0,
  inserted:  0,
  skipped:   0,
  errors:    0,
  byCollection: new Map<string, number>(),
};

// ─── Document router ──────────────────────────────────────────────────────────

function getCollectionForDoc(doc: any): { instrument: Instrument; year: number } | null {
  const underlying = doc.underlying?.toUpperCase() as Instrument;
  if (!underlying || !INSTRUMENTS.includes(underlying)) return null;
  const candle = doc.candle as string;
  if (!candle) return null;
  const year = new Date(candle).getFullYear();
  if (isNaN(year)) return null;
  return { instrument: underlying, year };
}

// ─── Batch insert with upsert ─────────────────────────────────────────────────

async function insertBatch(docs: any[]): Promise<void> {
  if (!docs.length) return;

  // Group by collection
  const groups = new Map<string, any[]>();
  for (const doc of docs) {
    const route = getCollectionForDoc(doc);
    if (!route) { stats.skipped++; continue; }
    const key = `${route.instrument}|${route.year}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(doc);
  }

  for (const [key, groupDocs] of groups) {
    const [instrument, yearStr] = key.split('|');
    const year = parseInt(yearStr);
    const collName = `option_chain_${instrument.toLowerCase()}_${year}`;

    if (dryRun) {
      console.log(`  [DRY RUN] Would insert ${groupDocs.length} docs into ${collName}`);
      stats.inserted += groupDocs.length;
      stats.byCollection.set(collName, (stats.byCollection.get(collName) ?? 0) + groupDocs.length);
      continue;
    }

    try {
      const model = getOptionChainModel(instrument as Instrument, year);
      const ops = groupDocs.map(doc => ({
        updateOne: {
          filter: { candle: doc.candle, underlying: doc.underlying },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      }));

      const result = await model.bulkWrite(ops, { ordered: false });
      const inserted = result.upsertedCount;
      const skipped  = groupDocs.length - inserted;

      stats.inserted += inserted;
      stats.skipped  += skipped;
      stats.byCollection.set(collName, (stats.byCollection.get(collName) ?? 0) + inserted);

    } catch (err: any) {
      console.error(`  Error inserting into ${collName}: ${err.message}`);
      stats.errors += groupDocs.length;
    }
  }
}

// ─── File parsers ─────────────────────────────────────────────────────────────

async function processFile(file: string): Promise<void> {
  console.log(`\nProcessing: ${file}`);
  const ext = path.extname(file).toLowerCase();

  if (ext === '.ndjson' || ext === '.jsonl') {
    await processNdjson(file);
  } else {
    await processJsonFile(file);
  }
}

async function processJsonFile(file: string): Promise<void> {
  const content = fs.readFileSync(file, 'utf8');
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    console.error(`  JSON parse error: ${err.message}`);
    stats.errors++;
    return;
  }

  const docs = Array.isArray(parsed) ? parsed : [parsed];
  stats.total += docs.length;

  // Process in batches
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    await insertBatch(batch);
    process.stdout.write(`\r  Progress: ${Math.min(i + batchSize, docs.length)}/${docs.length}`);
  }
  console.log('');
}

async function processNdjson(file: string): Promise<void> {
  const rl = readline.createInterface({
    input:    fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  let batch: any[] = [];
  let lineNum = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNum++;
    stats.total++;

    try {
      batch.push(JSON.parse(trimmed));
    } catch {
      stats.errors++;
      continue;
    }

    if (batch.length >= batchSize) {
      await insertBatch(batch);
      batch = [];
      process.stdout.write(`\r  Lines processed: ${lineNum}`);
    }
  }

  if (batch.length) {
    await insertBatch(batch);
    process.stdout.write(`\r  Lines processed: ${lineNum}`);
  }
  console.log('');
}

// ─── Directory processor ──────────────────────────────────────────────────────

async function processDir(dir: string): Promise<void> {
  const entries = fs.readdirSync(dir);
  const files = entries
    .filter(f => ['.json', '.ndjson', '.jsonl'].includes(path.extname(f).toLowerCase()))
    .map(f => path.join(dir, f))
    .sort();

  if (!files.length) {
    console.error(`No JSON/NDJSON files found in ${dir}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} file(s) in ${dir}`);
  for (const file of files) {
    await processFile(file);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!dryRun) {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/algo_backtest';
    await mongoose.connect(uri, { maxPoolSize: 5 });
    console.log(`Connected to MongoDB: ${uri}`);
  } else {
    console.log('[DRY RUN MODE — no data will be written]');
  }

  const start = Date.now();

  if (filePath) {
    await processFile(filePath);
  } else if (dirPath) {
    await processDir(dirPath);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(50));
  console.log('Import complete');
  console.log(`  Total docs processed: ${stats.total.toLocaleString()}`);
  console.log(`  Inserted (new):       ${stats.inserted.toLocaleString()}`);
  console.log(`  Skipped (duplicates): ${stats.skipped.toLocaleString()}`);
  console.log(`  Errors:               ${stats.errors.toLocaleString()}`);
  console.log(`  Time:                 ${elapsed}s`);
  console.log('\nBy collection:');
  for (const [coll, count] of [...stats.byCollection.entries()].sort()) {
    console.log(`  ${coll}: ${count.toLocaleString()} inserted`);
  }
  console.log('='.repeat(50));

  if (!dryRun) await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
