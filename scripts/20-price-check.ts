// Fetches live hourly prices and prints the current regime. Sends nothing to the blockchain.
// Run:    npm run pricecheck            (SOLUSDT)
//         npm run pricecheck -- BTCUSDT
import { MULTIPLIER_BPS, classify, computeFeatures } from '../src/regime/engine.ts';

const BASE = process.env.PRICE_API ?? 'https://data-api.binance.vision';
const symbol = (process.argv[2] ?? 'SOLUSDT').toUpperCase();
const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=1h&limit=800`;

let res: Response;
try {
  res = await fetch(url);
} catch (e) {
  console.error('Network error, check your internet connection or firewall:', (e as Error).message);
  process.exit(1);
}
if (!res.ok) {
  console.error(`Price server returned ${res.status}.`);
  if (res.status === 451) console.error('This server is blocked in your region. A different price source will be needed.');
  if (res.status === 429) console.error('Too many requests. Try again in a little while.');
  process.exit(1);
}

// Each candle: [openTime, open, high, low, close, volume, closeTime, ...]
const rows = (await res.json()) as unknown[][];
const now = Date.now();
const closed = rows.filter((r) => Number(r[6]) < now); // completed candles only
const closes = closed.map((r) => Number(r[4]));

if (closes.length < 72) {
  console.error(`Only ${closes.length} candles received, at least 72 are needed.`);
  process.exit(1);
}

const lastClose = closed[closed.length - 1];
console.log(`Symbol: ${symbol}`);
console.log(`Candles (completed): ${closes.length}`);
console.log(`Last candle closed: ${new Date(Number(lastClose[6])).toISOString()}`);
console.log(`Last price: ${closes[closes.length - 1]}`);

const f = computeFeatures(closes);
const regime = classify(f);
console.log('Features:', {
  volRatio: Number(f.volRatio.toFixed(3)),
  drawdown: Number(f.drawdown.toFixed(4)),
  shockZ: Number(f.shockZ.toFixed(3)),
  trend: Number(f.trend.toFixed(4)),
});
console.log(`REGIME: ${regime}  (limit ${MULTIPLIER_BPS[regime] / 100}%)`);
