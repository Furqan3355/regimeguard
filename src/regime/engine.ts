// RegimeGuard regime engine: pure functions (no network, no chain).
// Input: hourly closing prices. Output: regime + multiplier.

export type Regime = 'CALM' | 'TREND' | 'VOLATILE' | 'CRISIS';

export const SEVERITY: Record<Regime, number> = { CALM: 0, TREND: 1, VOLATILE: 2, CRISIS: 3 };

// basis points: 10000 = 100% of base limit
export const MULTIPLIER_BPS: Record<Regime, number> = {
  CALM: 10000,
  TREND: 8000,
  VOLATILE: 3000,
  CRISIS: 0,
};

// Thresholds. These are initial estimates and still need calibrating with a backtest.
export const THRESHOLDS = {
  crisisDrawdown: 0.15,
  crisisVolRatio: 3,
  crisisShockZ: 6,
  volatileDrawdown: 0.08,
  volatileVolRatio: 1.5,
  volatileShockZ: 3.5,
  trendStrength: 0.005,
};

export interface Features {
  volRatio: number; // volatility of the last 24h / longer-term (up to 30d) volatility
  drawdown: number; // drop from the 7-day peak (0.10 = 10%)
  shockZ: number; // largest move in the last 3 hours relative to normal volatility
  trend: number; // (EMA20 - EMA50) / EMA50
}

export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (!(closes[i] > 0) || !(closes[i - 1] > 0)) throw new Error('prices must be positive');
    out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

// Latest EMA value
export function ema(xs: number[], period: number): number {
  const k = 2 / (period + 1);
  let e = xs[0];
  for (let i = 1; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

export const MIN_CANDLES = 72;

export function computeFeatures(closes: number[]): Features {
  if (closes.length < MIN_CANDLES) {
    throw new Error(`at least ${MIN_CANDLES} hourly candles are needed, got ${closes.length}`);
  }
  const rets = logReturns(closes);
  const base = rets.slice(-720);
  const baseMean = mean(base);
  const baseSigma = stdev(base);
  const vol24 = stdev(rets.slice(-24));

  const volRatio = baseSigma > 0 ? vol24 / baseSigma : 1;

  const last3 = rets.slice(-3);
  const shockZ =
    baseSigma > 0 ? Math.max(...last3.map((r) => Math.abs(r - baseMean) / baseSigma)) : 0;

  const window = closes.slice(-168);
  const peak = Math.max(...window);
  const drawdown = (peak - closes[closes.length - 1]) / peak;

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const trend = (e20 - e50) / e50;

  return { volRatio, drawdown, shockZ, trend };
}

export function classify(f: Features, t = THRESHOLDS): Regime {
  if (f.drawdown >= t.crisisDrawdown || f.volRatio >= t.crisisVolRatio || f.shockZ >= t.crisisShockZ)
    return 'CRISIS';
  if (f.volRatio >= t.volatileVolRatio || f.drawdown >= t.volatileDrawdown || f.shockZ >= t.volatileShockZ)
    return 'VOLATILE';
  if (Math.abs(f.trend) >= t.trendStrength) return 'TREND';
  return 'CALM';
}

// Hysteresis: risk goes up immediately, and comes down only after several consecutive calmer readings.
export interface HystState {
  current: Regime;
  pendingLower: number;
}

export function stepHysteresis(state: HystState, raw: Regime, calmReadings = 3): HystState {
  if (SEVERITY[raw] > SEVERITY[state.current]) return { current: raw, pendingLower: 0 };
  if (SEVERITY[raw] === SEVERITY[state.current]) return { current: state.current, pendingLower: 0 };
  const pending = state.pendingLower + 1;
  if (pending >= calmReadings) return { current: raw, pendingLower: 0 };
  return { current: state.current, pendingLower: pending };
}

// If the oracle is stale, use the strictest regime (fail-safe).
export function applyStaleness(regime: Regime, updatedAtSec: number, nowSec: number, maxAgeSec: number): Regime {
  return nowSec - updatedAtSec > maxAgeSec ? 'CRISIS' : regime;
}

export function effectiveLimit(baseLimit: bigint, regime: Regime): bigint {
  return (baseLimit * BigInt(MULTIPLIER_BPS[regime])) / 10000n;
}
