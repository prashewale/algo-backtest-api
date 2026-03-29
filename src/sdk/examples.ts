/**
 * SDK Usage Examples
 * These run against a live API server. Set BASE_URL to your server.
 *
 * Run:  npx ts-node src/sdk/examples.ts
 */
import { AlgoBacktestClient } from './client';

const client = new AlgoBacktestClient(process.env.BASE_URL ?? 'http://localhost:3000');

async function exampleRunBacktest() {
  console.log('\n=== Run Backtest ===');

  // 1. Build config from a template
  const config = await client.strategy.buildFromTemplate({
    templateKey: 'short_straddle',
    instrument:  'NIFTY',
    startDate:   '2024-01-01',
    endDate:     '2024-03-31',
    capital:     500_000,
    lotSize:     50,
    entryTime:   '09:30',
    exitTime:    '15:15',
  });

  // 2. Add condition-based entry: VIX < 18 AND IV between 12-20%
  config.conditions = {
    entry: {
      id: 'g-entry',
      type: 'group',
      logic: 'AND',
      children: [
        { id: 'c1', type: 'condition', field: 'vix.close',  operator: 'lt',         rhsType: 'value', rhsValue: 18 },
        { id: 'c2', type: 'condition', field: 'iv_avg',     operator: 'is_between',  rhsType: 'value', rhsFrom: 0.12, rhsTo: 0.20 },
        { id: 'c3', type: 'condition', field: 'time.days_to_expiry', operator: 'is_between', rhsType: 'value', rhsFrom: 1, rhsTo: 5 },
      ],
    },
    stopLoss: {
      id: 'c-sl', type: 'condition',
      field: 'straddle_premium', operator: 'gt',
      rhsType: 'pct_of_field', rhsField: 'straddle_premium', rhsValue: 150,
    },
  };

  // 3. Submit and poll
  console.log('Submitting backtest…');
  const result = await client.backtests.run(
    { config, priority: 'high' },
    {
      intervalMs:  3000,
      timeoutMs:   300_000,
      onProgress:  pct => process.stdout.write(`\rProgress: ${pct}%   `),
    },
  );

  console.log('\n--- Summary ---');
  const s = result.summary;
  console.log(`Net P&L:       ₹${s.netPnl.toLocaleString()}`);
  console.log(`Total Return:  ${s.totalReturn}%`);
  console.log(`CAGR:          ${s.cagr}%`);
  console.log(`Sharpe:        ${s.sharpe}`);
  console.log(`Max Drawdown:  ${s.maxDrawdown}%`);
  console.log(`Win Rate:      ${s.winRate}%  (${s.wins}W / ${s.losses}L)`);
  console.log(`Profit Factor: ${s.profitFactor}`);
  console.log(`Total Trades:  ${s.totalTrades}`);
}

async function exampleSimulator() {
  console.log('\n=== Options Simulator ===');

  // Start a session
  const session = await client.simulator.createSession({
    instrument:     'NIFTY',
    startCandle:    '2024-01-01T09:16:00',
    initialCapital: 500_000,
  });
  console.log(`Session: ${session.sessionId}`);

  // Get market snapshot
  const market = await client.simulator.getMarket(session.sessionId);
  console.log(`Spot: ₹${market.spot}  VIX: ${market.vix}`);
  console.log(`Nearest expiry: ${market.nearestExpiry?.expiry}  ATM: ${market.nearestExpiry?.atmStrike}`);
  console.log(`Straddle premium: ₹${market.nearestExpiry?.straddlePremium}`);

  if (!market.nearestExpiry) {
    console.log('No expiry data — skip');
    return;
  }

  // Sell ATM straddle
  const atm = market.nearestExpiry.atmStrike;
  const expiry = market.nearestExpiry.expiry;

  const { position: callPos } = await client.simulator.openPosition(session.sessionId, {
    expiry,
    strike:     atm,
    optionType: 'CE',
    action:     'SELL',
    lots:       1,
    lotSize:    50,
  });
  console.log(`Sold ${atm} CE @ ₹${callPos.entryPrice}`);

  const { position: putPos } = await client.simulator.openPosition(session.sessionId, {
    expiry,
    strike:     atm,
    optionType: 'PE',
    action:     'SELL',
    lots:       1,
    lotSize:    50,
  });
  console.log(`Sold ${atm} PE @ ₹${putPos.entryPrice}`);

  // Advance 30 candles (30 minutes)
  for (let i = 0; i < 3; i++) {
    const s = await client.simulator.advance(session.sessionId, 10);
    const candle = await client.simulator.getCandle(session.sessionId);
    const pos = candle.session.positions;
    const totalPnl = candle.session.totalPnl;
    console.log(`Candle ${s.currentCandle}  unrealized P&L: ₹${totalPnl.toFixed(0)}`);
  }

  // Close both positions
  await client.simulator.closePosition(session.sessionId, callPos.id);
  await client.simulator.closePosition(session.sessionId, putPos.id);

  const final = await client.simulator.getSession(session.sessionId);
  console.log(`Final realized P&L: ₹${final.totalPnl.toFixed(0)}`);

  // Clean up
  await client.simulator.deleteSession(session.sessionId);
  console.log('Session closed');
}

async function exampleMarginCalculation() {
  console.log('\n=== Margin Calculation ===');

  const result = await client.strategy.calculateMargin({
    CalculateForExpiryDay: false,
    IndexPrices: { NIFTY: 21726 } as any,
    ListOfPosition: [
      { Ticker: 'NIFTY', Strike: 21700, InstrumentType: 'CE', NetQty: -1, Expiry: '2024-01-04', Premium: 100 },
      { Ticker: 'NIFTY', Strike: 21700, InstrumentType: 'PE', NetQty: -1, Expiry: '2024-01-04', Premium: 95 },
      { Ticker: 'NIFTY', Strike: 22000, InstrumentType: 'CE', NetQty:  1, Expiry: '2024-01-04', Premium: 20 },
      { Ticker: 'NIFTY', Strike: 21400, InstrumentType: 'PE', NetQty:  1, Expiry: '2024-01-04', Premium: 18 },
    ],
  });

  console.log(`SPAN Margin:     ₹${result.FinalSpan.toLocaleString()}`);
  console.log(`Exposure Margin: ₹${result.FinalExposure.toLocaleString()}`);
  console.log(`Hedge Benefit:   ₹${result.MarginBenefit.toLocaleString()}`);
  console.log(`Total Required:  ₹${result.TotalMargin.toLocaleString()}`);
}

async function exampleCompareStrategies() {
  console.log('\n=== Compare Strategies ===');

  const base = {
    instrument: 'NIFTY' as const,
    startDate:  '2024-01-01',
    endDate:    '2024-03-31',
    capital:    500_000,
    lotSize:    50,
  };

  // Queue 3 strategies in parallel
  const [j1, j2, j3] = await Promise.all([
    client.backtests.create({ config: await client.strategy.buildFromTemplate({ templateKey: 'short_straddle',  ...base }) }),
    client.backtests.create({ config: await client.strategy.buildFromTemplate({ templateKey: 'short_strangle',  ...base }) }),
    client.backtests.create({ config: await client.strategy.buildFromTemplate({ templateKey: 'iron_condor',     ...base }) }),
  ]);

  console.log(`Queued: ${j1.jobId}, ${j2.jobId}, ${j3.jobId}`);

  // Wait for all
  const [r1, r2, r3] = await Promise.all([
    client.backtests.waitForResult(j1.jobId),
    client.backtests.waitForResult(j2.jobId),
    client.backtests.waitForResult(j3.jobId),
  ]);

  console.log('\nStrategy Comparison:');
  console.log('Strategy         Return   Sharpe  WinRate  MaxDD');
  for (const [name, r] of [['Short Straddle', r1], ['Short Strangle', r2], ['Iron Condor', r3]] as const) {
    const s = r.summary;
    console.log(
      `${name.padEnd(16)} ${String(s.totalReturn + '%').padEnd(8)} ${String(s.sharpe).padEnd(7)} ${String(s.winRate + '%').padEnd(8)} ${s.maxDrawdown}%`
    );
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const health = await client.health();
    console.log(`API health: ${health.status}  uptime: ${health.uptime}s`);
  } catch (e) {
    console.error('Cannot connect to API. Is the server running?');
    process.exit(1);
  }

  await exampleMarginCalculation();
  await exampleSimulator();
  // await exampleRunBacktest();       // uncomment — needs real MongoDB data
  // await exampleCompareStrategies(); // uncomment — needs real MongoDB data
})();
