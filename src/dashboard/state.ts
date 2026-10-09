// Builds the dashboard data (pure function, no blockchain work).
import { MULTIPLIER_BPS, type Regime } from '../regime/engine.ts';
import { budget, currentRegime, fmtTokens } from '../agent/agent.ts';
import type { AgentEvent } from '../agent/log.ts';
import type { DecodedOracle, DecodedPolicy } from '../chain/guard.ts';

const NAMES: Regime[] = ['CALM', 'TREND', 'VOLATILE', 'CRISIS'];

export interface DashboardState {
  nowSec: number;
  regime: Regime; // what the guard will actually enforce
  oracleRegime: Regime | 'UNKNOWN'; // what is written in the oracle
  multiplierPct: number;
  oracleAgeSecs: number | null;
  oracleStale: boolean;
  limitToday: string;
  baseLimit: string;
  spent: string;
  remaining: string;
  usedPct: number; // 0..100
  paused: boolean;
  demoCrash: boolean;
  events: AgentEvent[];
  addresses: { agent: string; oracle: string; program: string; policy: string };
}

export function buildState(input: {
  nowSec: number;
  policy: DecodedPolicy;
  oracle: DecodedOracle;
  demoCrash: boolean;
  events: AgentEvent[];
  addresses: DashboardState['addresses'];
}): DashboardState {
  const { nowSec, policy, oracle } = input;
  const regime = currentRegime(oracle, policy, nowSec);
  const b = budget(policy, regime, nowSec);
  const age = oracle.updatedAt > 0n ? nowSec - Number(oracle.updatedAt) : null;
  const stale = age === null || age < 0 || BigInt(age) > policy.maxStalenessSecs;
  const used = b.limit > 0n ? Math.min(100, Number((b.spent * 10_000n) / b.limit) / 100) : b.spent > 0n ? 100 : 0;

  return {
    nowSec,
    regime,
    oracleRegime: oracle.regime <= 3 ? NAMES[oracle.regime] : 'UNKNOWN',
    multiplierPct: MULTIPLIER_BPS[regime] / 100,
    oracleAgeSecs: age,
    oracleStale: stale,
    limitToday: fmtTokens(b.limit),
    baseLimit: fmtTokens(policy.baseDailyLimit),
    spent: fmtTokens(b.spent),
    remaining: fmtTokens(b.remaining),
    usedPct: used,
    paused: policy.paused,
    demoCrash: input.demoCrash,
    events: input.events,
    addresses: input.addresses,
  };
}
