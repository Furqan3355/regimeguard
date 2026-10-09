import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budget,
  currentRegime,
  decide,
  explainError,
  nextDelaySecs,
  type Snapshot,
} from '../src/agent/agent.ts';

const T = (n: number) => BigInt(n) * 1_000_000n;
const NOW = 1_800_000_000; // any time works
const DAY = BigInt(Math.floor(NOW / 86_400));

function snap(opts: {
  regime?: number;
  updatedAgo?: number;
  paused?: boolean;
  spent?: bigint;
  day?: bigint;
  base?: bigint;
}): Snapshot {
  return {
    nowSec: NOW,
    policy: {
      owner: 'o',
      agent: 'a',
      baseDailyLimit: opts.base ?? T(100),
      maxStalenessSecs: 600n,
      day: opts.day ?? DAY,
      spent: opts.spent ?? 0n,
      paused: opts.paused ?? false,
    },
    oracle: {
      authority: 'x',
      regime: opts.regime ?? 0,
      updatedAt: BigInt(NOW - (opts.updatedAgo ?? 10)),
    },
  };
}

test('CALM: the agent asks for the full amount', () => {
  const a = decide(snap({}), T(5), T(1), false);
  assert.equal(a.kind, 'pull');
  if (a.kind === 'pull') assert.equal(a.amount, T(5));
});

test('near the limit: the agent only asks for what is left', () => {
  const a = decide(snap({ spent: T(98) }), T(5), T(1), false);
  assert.equal(a.kind, 'pull');
  if (a.kind === 'pull') assert.equal(a.amount, T(2));
});

test('limit used up: the agent waits', () => {
  const a = decide(snap({ spent: T(100) }), T(5), T(1), false);
  assert.deepEqual(a.kind === 'wait' && a.status, 'LIMIT_REACHED');
});

test('VOLATILE: limit is 30, the agent never asks for more than that', () => {
  const a = decide(snap({ regime: 2, spent: T(28) }), T(5), T(1), false);
  assert.equal(a.kind, 'pull');
  if (a.kind === 'pull') assert.equal(a.amount, T(2));
});

test('CRISIS: the agent waits (BLOCKED)', () => {
  const a = decide(snap({ regime: 3 }), T(5), T(1), false);
  assert.deepEqual(a.kind === 'wait' && a.status, 'BLOCKED');
});

test('stale oracle: the agent treats it as CRISIS', () => {
  assert.equal(currentRegime(snap({ updatedAgo: 700 }).oracle, snap({}).policy, NOW), 'CRISIS');
  const a = decide(snap({ updatedAgo: 700 }), T(5), T(1), false);
  assert.deepEqual(a.kind === 'wait' && a.status, 'BLOCKED');
});

test('paused: the agent waits', () => {
  const a = decide(snap({ paused: true }), T(5), T(1), false);
  assert.deepEqual(a.kind === 'wait' && a.status, 'PAUSED');
});

test('new day: spending counts from zero', () => {
  const b = budget(snap({ spent: T(100), day: DAY - 1n }).policy, 'CALM', NOW);
  assert.equal(b.spent, 0n);
  assert.equal(b.remaining, T(100));
});

test('stubborn agent asks for the full amount even in CRISIS (the chain will stop it)', () => {
  const a = decide(snap({ regime: 3 }), T(5), T(1), true);
  assert.equal(a.kind, 'pull');
  if (a.kind === 'pull') assert.equal(a.amount, T(5));
});

test('backoff: doubles after a rejection, returns to base after a success', () => {
  assert.equal(nextDelaySecs(15, true, 15, 120), 30);
  assert.equal(nextDelaySecs(100, true, 15, 120), 120);
  assert.equal(nextDelaySecs(60, false, 15, 120), 15);
});

test('explainError: maps the guard error code to its name', () => {
  assert.equal(explainError('failed: custom program error: 0x5'), 'LimitExceeded');
  assert.equal(explainError('custom program error: 0x2'), 'Paused');
  assert.match(explainError('fetch failed'), /network/);
});
