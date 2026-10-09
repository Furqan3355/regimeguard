// Brain of the autonomous agent (pure functions, no blockchain work).
// The agent's decisions come from fixed rules; no LLM makes decisions.
import { effectiveLimit, type Regime } from '../regime/engine.ts';
import type { DecodedOracle, DecodedPolicy } from '../chain/guard.ts';

const REGIME_NAMES: Regime[] = ['CALM', 'TREND', 'VOLATILE', 'CRISIS'];
const GUARD_ERRORS: Record<number, string> = {
  1: 'NotAgent',
  2: 'Paused',
  3: 'OracleMismatch',
  4: 'BadAccount',
  5: 'LimitExceeded',
  6: 'BadData',
  7: 'BadAuthority',
  8: 'BadRegime',
  9: 'WrongOwner',
};

export interface Snapshot {
  nowSec: number;
  policy: DecodedPolicy;
  oracle: DecodedOracle;
}

export type Action =
  | { kind: 'pull'; amount: bigint; note: string }
  | { kind: 'wait'; status: 'PAUSED' | 'BLOCKED' | 'LIMIT_REACHED'; note: string };

/** Same logic as the guard: a stale or invalid oracle means CRISIS. */
export function currentRegime(o: DecodedOracle, p: DecodedPolicy, nowSec: number): Regime {
  const now = BigInt(nowSec);
  if (o.regime > 3 || o.updatedAt <= 0n || now < o.updatedAt) return 'CRISIS';
  return now - o.updatedAt > p.maxStalenessSecs ? 'CRISIS' : REGIME_NAMES[o.regime];
}

export function budget(p: DecodedPolicy, regime: Regime, nowSec: number) {
  const day = BigInt(Math.floor(nowSec / 86_400));
  const spent = p.day === day ? p.spent : 0n;
  const limit = effectiveLimit(p.baseDailyLimit, regime);
  return { limit, spent, remaining: limit > spent ? limit - spent : 0n };
}

/**
 * What should the agent do?
 * - normal agent: checks its own limit first, then asks for less or waits
 * - stubborn agent: always asks for the full amount (to show in the demo that the chain itself blocks it)
 */
export function decide(s: Snapshot, want: bigint, minBuy: bigint, stubborn: boolean): Action {
  if (stubborn) return { kind: 'pull', amount: want, note: 'stubborn mode: requesting the full amount regardless of the limit' };
  if (s.policy.paused) return { kind: 'wait', status: 'PAUSED', note: 'paused by the owner' };

  const regime = currentRegime(s.oracle, s.policy, s.nowSec);
  const b = budget(s.policy, regime, s.nowSec);
  if (b.limit === 0n) return { kind: 'wait', status: 'BLOCKED', note: `regime ${regime}: today's limit is 0` };

  const amount = want < b.remaining ? want : b.remaining;
  if (amount < minBuy) return { kind: 'wait', status: 'LIMIT_REACHED', note: `regime ${regime}: today's limit is used up` };
  return { kind: 'pull', amount, note: `regime ${regime}: requesting within today's limit` };
}

/** After a rejection back off for longer; after a success return to the base delay. */
export function nextDelaySecs(current: number, rejected: boolean, base: number, max: number): number {
  return rejected ? Math.min(current * 2, max) : base;
}

/** Extract the guard's error name from a web3.js error message. */
export function explainError(message: string): string {
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(message);
  if (!m) return 'other problem (network/RPC)';
  const code = parseInt(m[1], 16);
  return GUARD_ERRORS[code] ?? `program error ${code}`;
}

export function fmtTokens(v: bigint): string {
  return (Number(v) / 1_000_000).toFixed(2);
}
