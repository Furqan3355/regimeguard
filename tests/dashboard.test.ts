import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildState } from '../src/dashboard/state.ts';
import { appendEvent, readEvents } from '../src/agent/log.ts';

const T = (n: number) => BigInt(n) * 1_000_000n;
const NOW = 1_800_000_000;
const DAY = BigInt(Math.floor(NOW / 86_400));
const addresses = { agent: 'a', oracle: 'o', program: 'p', policy: 'q' };

const mk = (o: { regime?: number; ago?: number; spent?: bigint; paused?: boolean }) =>
  buildState({
    nowSec: NOW,
    policy: {
      owner: 'x',
      agent: 'a',
      baseDailyLimit: T(100),
      maxStalenessSecs: 600n,
      day: DAY,
      spent: o.spent ?? 0n,
      paused: o.paused ?? false,
    },
    oracle: { authority: 'x', regime: o.regime ?? 0, updatedAt: BigInt(NOW - (o.ago ?? 20)) },
    demoCrash: false,
    events: [],
    addresses,
  });

test('CALM: full limit, empty bar', () => {
  const s = mk({});
  assert.equal(s.regime, 'CALM');
  assert.equal(s.multiplierPct, 100);
  assert.equal(s.limitToday, '100.00');
  assert.equal(s.usedPct, 0);
  assert.equal(s.oracleStale, false);
});

test('VOLATILE: limit 30, with 15 spent the bar is at 50%', () => {
  const s = mk({ regime: 2, spent: T(15) });
  assert.equal(s.limitToday, '30.00');
  assert.equal(s.remaining, '15.00');
  assert.equal(s.usedPct, 50);
});

test('CRISIS: limit 0 with spending already done gives a full bar', () => {
  const s = mk({ regime: 3, spent: T(5) });
  assert.equal(s.limitToday, '0.00');
  assert.equal(s.usedPct, 100);
});

test('stale oracle: effective regime is CRISIS, stale flag is set, and the regime written in the oracle is still shown', () => {
  const s = mk({ regime: 0, ago: 700 });
  assert.equal(s.regime, 'CRISIS');
  assert.equal(s.oracleRegime, 'CALM');
  assert.equal(s.oracleStale, true);
  assert.equal(s.multiplierPct, 0);
});

test('paused flag is shown', () => {
  assert.equal(mk({ paused: true }).paused, true);
});

test('event log: newest first, skips corrupt lines', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-')), 'log.jsonl');
  appendEvent({ t: 1, kind: 'BUY', amount: '5.00', note: 'first' }, f);
  fs.appendFileSync(f, 'corrupt line\n');
  appendEvent({ t: 2, kind: 'REJECTED', note: 'second' }, f);
  const ev = readEvents(10, f);
  assert.deepEqual(ev.map((e) => e.t), [2, 1]);
});

test('event log: empty list when the file does not exist', () => {
  assert.deepEqual(readEvents(5, '/tmp/rg-does-not-exist.jsonl'), []);
});

test('event log: never returns more than the limit', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-')), 'log.jsonl');
  for (let i = 1; i <= 10; i++) appendEvent({ t: i, kind: 'WAIT', note: 'x' }, f);
  assert.equal(readEvents(3, f).length, 3);
  assert.equal(readEvents(3, f)[0].t, 10);
});
