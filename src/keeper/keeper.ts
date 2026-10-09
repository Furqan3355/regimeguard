// Keeper logic: fetch prices, decide the regime, and say whether the oracle needs a write.
// This file does no blockchain work (which is why its tests are easy).
import {
  classify,
  computeFeatures,
  stepHysteresis,
  type Features,
  type HystState,
  type Regime,
} from '../regime/engine.ts';

export type FetchFn = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export const DEFAULT_BASE = 'https://data-api.binance.vision';

/** Binance klines: [openTime, open, high, low, close, volume, closeTime, ...]. Returns the closes of completed candles only. */
export function parseKlines(rows: unknown[][], nowMs: number): number[] {
  return rows.filter((r) => Number(r[6]) < nowMs).map((r) => Number(r[4]));
}

export async function fetchCloses(
  symbol: string,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
  base: string = DEFAULT_BASE,
  nowMs: number = Date.now(),
): Promise<number[]> {
  const res = await fetchFn(`${base}/api/v3/klines?symbol=${symbol}&interval=1h&limit=800`);
  if (!res.ok) throw new Error(`price server returned ${res.status}`);
  const closes = parseKlines((await res.json()) as unknown[][], nowMs);
  if (closes.length < 72) throw new Error(`only ${closes.length} candles received, need 72`);
  return closes;
}

/** For demos: append a fake crash after the real prices. */
export function simulate(closes: number[], mode: 'crash' | 'none'): number[] {
  if (mode === 'none') return closes;
  const last = closes[closes.length - 1];
  return [...closes, last * 0.93, last * 0.9]; // -7% then -3.2%
}

export interface KeeperState {
  hyst: HystState | null; // null on the first run
  lastWriteMs: number;
}

export interface StepResult {
  state: KeeperState;
  raw: Regime; // what this round's prices said
  regime: Regime; // the real regime after hysteresis
  shouldWrite: boolean;
  why: 'first-run' | 'regime-changed' | 'heartbeat' | 'no-change';
  features: Features;
}

export function step(
  state: KeeperState,
  closes: number[],
  nowMs: number,
  heartbeatMs: number,
  calmReadings = 3,
): StepResult {
  const features = computeFeatures(closes);
  const raw = classify(features);
  const hyst = state.hyst ? stepHysteresis(state.hyst, raw, calmReadings) : { current: raw, pendingLower: 0 };

  const first = state.hyst === null;
  const changed = state.hyst !== null && hyst.current !== state.hyst.current;
  const stale = nowMs - state.lastWriteMs >= heartbeatMs;

  const shouldWrite = first || changed || stale;
  const why = first ? 'first-run' : changed ? 'regime-changed' : stale ? 'heartbeat' : 'no-change';

  return {
    state: { hyst, lastWriteMs: shouldWrite ? nowMs : state.lastWriteMs },
    raw,
    regime: hyst.current,
    shouldWrite,
    why,
    features,
  };
}
