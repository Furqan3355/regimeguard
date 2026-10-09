import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCloses,
  parseKlines,
  simulate,
  step,
  type FetchFn,
  type KeeperState,
} from '../src/keeper/keeper.ts';

const HOUR = 3_600_000;

// fake Binance candles: [openTime, o, h, l, close, vol, closeTime]
function fakeRows(n: number, nowMs: number, includeOpen = true): unknown[][] {
  const rows: unknown[][] = [];
  let price = 100;
  const start = nowMs - n * HOUR;
  for (let i = 0; i < n; i++) {
    price *= i % 2 === 0 ? 1.002 : 0.998; // small ups and downs
    const open = start + i * HOUR;
    rows.push([open, 0, 0, 0, String(price), 0, open + HOUR - 1]);
  }
  if (includeOpen) rows.push([nowMs - 1000, 0, 0, 0, '999', 0, nowMs + HOUR]); // the candle still in progress
  return rows;
}

const okFetch = (rows: unknown[][]): FetchFn => async () => ({
  ok: true,
  status: 200,
  json: async () => rows,
});

test('parseKlines: drops the candle still in progress', () => {
  const now = 1_000_000_000_000;
  const closes = parseKlines(fakeRows(100, now), now);
  assert.equal(closes.length, 100);
  assert.ok(!closes.includes(999));
});

test('fetchCloses: gives a clear error on a server error', async () => {
  const bad: FetchFn = async () => ({ ok: false, status: 451, json: async () => ({}) });
  await assert.rejects(fetchCloses('SOLUSDT', bad), /451/);
});

test('fetchCloses: error when there are too few candles', async () => {
  const now = Date.now();
  await assert.rejects(fetchCloses('SOLUSDT', okFetch(fakeRows(10, now)), 'http://x', now), /72/);
});

test('fetchCloses: returns the closes for good data', async () => {
  const now = Date.now();
  const closes = await fetchCloses('SOLUSDT', okFetch(fakeRows(800, now)), 'http://x', now);
  assert.equal(closes.length, 800);
});

const fresh = (): KeeperState => ({ hyst: null, lastWriteMs: 0 });
const calmCloses = async (now: number) => fetchCloses('SOLUSDT', okFetch(fakeRows(800, now)), 'http://x', now);

test('first run: computes the regime and asks for a write', async () => {
  const now = Date.now();
  const r = step(fresh(), await calmCloses(now), now, 180_000);
  assert.equal(r.regime, 'CALM');
  assert.equal(r.shouldWrite, true);
  assert.equal(r.why, 'first-run');
});

test('same regime and heartbeat not due: no write needed', async () => {
  const now = Date.now();
  const closes = await calmCloses(now);
  const a = step(fresh(), closes, now, 180_000);
  const b = step(a.state, closes, now + 10_000, 180_000);
  assert.equal(b.shouldWrite, false);
  assert.equal(b.why, 'no-change');
});

test('heartbeat: writes even when the regime is the same, to keep the oracle fresh', async () => {
  const now = Date.now();
  const closes = await calmCloses(now);
  const a = step(fresh(), closes, now, 180_000);
  const b = step(a.state, closes, now + 200_000, 180_000);
  assert.equal(b.shouldWrite, true);
  assert.equal(b.why, 'heartbeat');
});

test('simulated crash: CRISIS immediately, and asks for a write', async () => {
  const now = Date.now();
  const closes = await calmCloses(now);
  const a = step(fresh(), closes, now, 180_000);
  const b = step(a.state, simulate(closes, 'crash'), now + 1000, 180_000);
  assert.equal(b.regime, 'CRISIS');
  assert.equal(b.shouldWrite, true);
  assert.equal(b.why, 'regime-changed');
});

test('after a crash, CALM returns only after 3 consecutive readings', async () => {
  const now = Date.now();
  const closes = await calmCloses(now);
  let s = step(fresh(), closes, now, 180_000);
  s = step(s.state, simulate(closes, 'crash'), now + 1000, 180_000);
  assert.equal(s.regime, 'CRISIS');
  s = step(s.state, closes, now + 2000, 180_000);
  assert.equal(s.regime, 'CRISIS');
  s = step(s.state, closes, now + 3000, 180_000);
  assert.equal(s.regime, 'CRISIS');
  s = step(s.state, closes, now + 4000, 180_000);
  assert.equal(s.regime, 'CALM');
  assert.equal(s.why, 'regime-changed');
});

test('simulate none: leaves the prices untouched', () => {
  const c = [1, 2, 3];
  assert.deepEqual(simulate(c, 'none'), c);
});
