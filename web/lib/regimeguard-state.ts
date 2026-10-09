export type GuardEvent = { t: string; kind: string; amount?: number | string; regime?: string; note: string; sig?: string }

export type GuardState = {
  regime: string
  multiplierPct: number
  oracleRegime: string
  oracleAgeSecs: number | null
  oracleStale: boolean
  paused: boolean
  spent: number
  limitToday: number
  remaining: number
  baseLimit: number
  usedPct: number
  demoCrash: boolean
  events: GuardEvent[]
  addresses: { program: string; oracle: string; policy: string; agent: string }
}

const now = () => new Date().toISOString()

const state: GuardState = {
  regime: 'CALM', multiplierPct: 100, oracleRegime: 'CALM', oracleAgeSecs: 18, oracleStale: false,
  paused: false, spent: 184, limitToday: 500, remaining: 316, baseLimit: 500, usedPct: 36.8,
  demoCrash: false,
  events: [{ t: now(), kind: 'AUTHORIZED', amount: 42, regime: 'CALM', note: 'Swap request approved', sig: 'demo-4x7k...p9Q' }],
  addresses: { program: 'RGd3moDemoGuard111111111111111111111111111', oracle: 'Orac1eDemo1111111111111111111111111111111', policy: 'Pol1cyDemo1111111111111111111111111111111', agent: 'Ag3ntDemo11111111111111111111111111111111' },
}

export function getState(): GuardState {
  const last = Date.parse(state.events[0]?.t ?? now())
  return { ...state, oracleAgeSecs: Math.max(0, Math.floor((Date.now() - last) / 1000)) }
}

export function applyAction(action: string, payload: Record<string, unknown> = {}) {
  if (action === 'pause' || action === 'kill-switch') state.paused = true
  if (action === 'resume') state.paused = false
  if (action === 'reset') { state.spent = 0; state.remaining = state.limitToday; state.usedPct = 0; state.paused = false }
  if (action === 'simulate-crash' || action === 'crash') { state.demoCrash = true; state.regime = 'STRESS'; state.oracleRegime = 'STRESS'; state.multiplierPct = 35; state.limitToday = 175; state.remaining = Math.max(0, state.limitToday - state.spent); state.usedPct = Math.min(100, (state.spent / state.limitToday) * 100) }
  if (action === 'set-limit' && typeof payload.limit === 'number' && payload.limit > 0) { state.baseLimit = payload.limit; state.limitToday = Math.round(payload.limit * state.multiplierPct / 100); state.remaining = Math.max(0, state.limitToday - state.spent); state.usedPct = Math.min(100, state.spent / state.limitToday * 100) }
  if (action === 'event' || action === 'authorize') { const amount = typeof payload.amount === 'number' ? payload.amount : 42; const approved = !state.paused && state.remaining >= amount; if (approved) { state.spent += amount; state.remaining = Math.max(0, state.limitToday - state.spent); state.usedPct = Math.min(100, state.spent / state.limitToday * 100) } state.events.unshift({ t: now(), kind: approved ? 'AUTHORIZED' : 'BLOCKED', amount, regime: state.regime, note: approved ? 'Policy check passed' : 'Policy blocked action', sig: `demo-${Math.random().toString(36).slice(2, 10)}` }); state.events = state.events.slice(0, 8) }
  return getState()
}

export function actionFromPath(path: string) {
  const last = path.split('/').filter(Boolean).pop() ?? 'event'
  return last === 'actions' ? 'event' : last
}

export function toPublicState() { return getState() }

export function resetForTests() { Object.assign(state, { paused: false, demoCrash: false, regime: 'CALM', oracleRegime: 'CALM', multiplierPct: 100, limitToday: 500, remaining: 316, spent: 184, usedPct: 36.8 }) }

export const guardState = state

export function validateRequest(headers: Headers) { return headers.get('x-regimeguard') === '1' || process.env.NODE_ENV !== 'production' }

export function jsonError(message: string, status = 400) { return Response.json({ error: message }, { status }) }

export const metadata = { name: 'RegimeGuard API', version: '0.1.0', environment: 'hackathon-demo', docs: '/#developers' }

export function apiResponse() { return { ok: true, data: getState(), metadata } }

export function health() { return { ok: true, service: 'regimeguard-api', status: 'operational', network: 'solana-devnet', timestamp: now() } }
