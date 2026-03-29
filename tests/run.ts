#!/usr/bin/env ts-node
/**
 * Test runner — unit + integration.
 *
 * Usage:
 *   npx ts-node tests/run.ts                  # all tests
 *   npx ts-node tests/run.ts --unit            # unit only
 *   npx ts-node tests/run.ts --integration     # integration only
 */

import { spawnSync } from 'child_process';
import path from 'path';

const unitTests = [
  'tests/unit/technicalIndicators.test.ts',
  'tests/unit/conditionEvaluator.test.ts',
  'tests/unit/marginCalculator.test.ts',
  'tests/unit/dataService.test.ts',
];

const integrationTests = [
  'tests/integration/backtestPipeline.test.ts',
  'tests/integration/analyticsPipeline.test.ts',
];

const runUnit        = process.argv.includes('--unit');
const runIntegration = process.argv.includes('--integration');
const tests = runUnit ? unitTests : runIntegration ? integrationTests : [...unitTests, ...integrationTests];

let totalPassed = 0, totalFailed = 0;

console.log('='.repeat(52));
console.log(' Algo Backtest API — Test Suite');
if (runUnit)        console.log(' Mode: unit only');
if (runIntegration) console.log(' Mode: integration only');
console.log('='.repeat(52));

for (const testFile of tests) {
  console.log(`\nRunning: ${testFile}`);
  console.log('-'.repeat(52));

  const result = spawnSync(
    'npx', ['ts-node', '--transpile-only', path.resolve(testFile)],
    { stdio: 'pipe', encoding: 'utf8' }
  );

  process.stdout.write(result.stdout);
  if (result.stderr && !result.stderr.includes('ExperimentalWarning')) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) totalFailed++;
  else totalPassed++;
}

console.log('\n' + '='.repeat(52));
console.log(`Files: ${tests.length}   Passed: ${totalPassed}   Failed: ${totalFailed}`);
console.log('='.repeat(52));

process.exit(totalFailed > 0 ? 1 : 0);
