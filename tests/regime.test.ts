import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStaleness,
  classify,
  computeFeatures,
  effectiveLimit,
  ema,
  logReturns,
  stdev,
  stepHysteresis,
  type HystState,
} from '../src/regime/engine.ts';

// build prices from a list of returns (starting at 100)
function closesFrom(returns: number[], start = 100): number[] {
  const out = [start];
  for (const r of returns) out.push(out[out.length - 1] * Math.exp(r));
  return out;
}
// +x, -x, +x, -x ... (n times)
function alternating(x: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? x : -x));
}
const regimeOf = (closes: number[]) => classify(computeFeatures(closes));

test('logReturns: 100 -> 110 gives a return of ln(1.1)', () => {
  const r = logReturns([100, 110]);
  assert.ok(Math.abs(r[0] - Math.log(1.1)) < 1e-12);
});

test('logReturns: error on a zero or negative price', () => {
  assert.throws(() => logReturns([100, 0]));
  assert.throws(() => logReturns([100, -5]));
});

test('stdev: a constant series has stdev 0', () => {
  assert.equal(stdev([0.01, 0.01, 0.01]), 0);
});

test('ema: the EMA of a constant series is that constant', () => {
  assert.ok(Math.abs(ema([5, 5, 5, 5, 5], 3) - 5) < 1e-12);
});

test('computeFeatures: error when there are too few candles', () => {
  assert.throws(() => computeFeatures(closesFrom(alternating(0.002, 10))));
});

test('CALM: gentle, even ups and downs', () => {
  const closes = closesFrom(alternating(0.002, 800));
  assert.equal(regimeOf(closes), 'CALM');
});

test('TREND: steady rise with normal volatility', () => {
  const closes = closesFrom(Array.from({ length: 800 }, () => 0.0006));
  assert.equal(regimeOf(closes), 'TREND');
});

test('VOLATILE: movement over the last 24 hours grew a lot', () => {
  const returns = [...alternating(0.002, 776), ...alternating(0.0045, 24)];
  const f = computeFeatures(closesFrom(returns));
  assert.ok(f.volRatio >= 1.5 && f.volRatio < 3, `volRatio=${f.volRatio}`);
  assert.equal(classify(f), 'VOLATILE');
});

test('CRISIS (drawdown): drop of more than 15% from the 7-day peak', () => {
  const returns = [...alternating(0.002, 700), ...Array.from({ length: 100 }, () => -0.002)];
  const f = computeFeatures(closesFrom(returns));
  assert.ok(f.drawdown >= 0.15, `drawdown=${f.drawdown}`);
  assert.equal(classify(f), 'CRISIS');
});

test('CRISIS (shock): sudden 6% drop within one hour (a news-like jolt)', () => {
  const returns = [...alternating(0.002, 800), -0.06];
  const f = computeFeatures(closesFrom(returns));
  assert.ok(f.shockZ >= 6, `shockZ=${f.shockZ}`);
  assert.equal(classify(f), 'CRISIS');
});

test('a jolt older than 4 hours no longer shows as a shock signal', () => {
  const returns = [...alternating(0.002, 800), -0.06, 0.002, -0.002, 0.002, -0.002];
  const f = computeFeatures(closesFrom(returns));
  assert.ok(f.shockZ < 6, `shockZ=${f.shockZ}`);
});

test('hysteresis: risk goes up immediately', () => {
  const s: HystState = { current: 'CALM', pendingLower: 0 };
  assert.deepEqual(stepHysteresis(s, 'CRISIS'), { current: 'CRISIS', pendingLower: 0 });
});

test('hysteresis: coming down needs 3 consecutive readings', () => {
  let s: HystState = { current: 'CRISIS', pendingLower: 0 };
  s = stepHysteresis(s, 'CALM');
  assert.equal(s.current, 'CRISIS');
  s = stepHysteresis(s, 'CALM');
  assert.equal(s.current, 'CRISIS');
  s = stepHysteresis(s, 'CALM');
  assert.equal(s.current, 'CALM');
});

test('hysteresis: if risk returns in between, the count resets', () => {
  let s: HystState = { current: 'CRISIS', pendingLower: 0 };
  s = stepHysteresis(s, 'CALM');
  s = stepHysteresis(s, 'CALM');
  s = stepHysteresis(s, 'CRISIS'); // back to equal
  assert.equal(s.pendingLower, 0);
  s = stepHysteresis(s, 'CALM');
  assert.equal(s.current, 'CRISIS');
});

test('staleness: a stale oracle gives the strictest regime', () => {
  assert.equal(applyStaleness('CALM', 1000, 1100, 300), 'CALM');
  assert.equal(applyStaleness('CALM', 1000, 1400, 300), 'CRISIS');
});

test('effectiveLimit: the limit follows the regime', () => {
  const base = 100_000_000n; // 100 tokens
  assert.equal(effectiveLimit(base, 'CALM'), 100_000_000n);
  assert.equal(effectiveLimit(base, 'TREND'), 80_000_000n);
  assert.equal(effectiveLimit(base, 'VOLATILE'), 30_000_000n);
  assert.equal(effectiveLimit(base, 'CRISIS'), 0n);
});

test('deterministic: the same input always gives the same result', () => {
  const closes = closesFrom(alternating(0.002, 800));
  assert.deepEqual(computeFeatures(closes), computeFeatures(closes));
});
