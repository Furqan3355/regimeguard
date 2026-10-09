# RegimeGuard

**Market-aware spending limits for AI agents on Solana, enforced on-chain.**

An AI agent gets an allowance. RegimeGuard makes that allowance *shrink automatically when the market turns dangerous* (volatile, crash) and restore when it calms down. The limit is enforced by a Solana program, so the agent cannot bypass it.

Built for the Colosseum Crypto World's Fair hackathon (Solana track). Runs on **devnet**.

---

## The problem

People hesitate to give AI agents real money. The common fix is a static cap ("max 100 USDC per day"), but a static cap is blind to the market: it lets an agent spend the full amount in the middle of a crash.

## The idea

```
market prices ──► regime engine ──► oracle account (on-chain)
                                         │
agent asks to spend ─► RegimeGuard program ─┤ limit = base daily limit × regime multiplier
                                         │
                                         ▼ (only if within limit)
                       Solana Subscriptions program ──► tokens move
```

| Regime | Meaning | Daily limit |
|---|---|---|
| CALM | normal market | 100% of base |
| TREND | clear trend, normal volatility | 80% |
| VOLATILE | volatility or drawdown elevated | 30% |
| CRISIS | crash / shock / stale data | 0% |

## Why Solana

- Uses Solana's native **Subscriptions & Allowances** program (`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, Fixed Delegation).
- The allowance's *delegatee* is a **program-derived address (PDA) owned by RegimeGuard**, not the agent. The guard signs the transfer via CPI (`invoke_signed`). The agent has no direct path to the funds.
- Cheap, frequent on-chain oracle updates make a live regime feed practical.

## Components

| Part | Where | What it does |
|---|---|---|
| Regime engine | `src/regime/engine.ts` | Pure functions: volatility ratio, 7-day drawdown, shock z-score, EMA trend → regime. Hysteresis: risk goes up immediately, comes down only after 3 consecutive calmer readings. |
| Keeper | `src/keeper/keeper.ts`, `scripts/21-keeper.ts` | Every 60s fetches hourly candles (Binance public market-data host, no key), computes the regime, writes it to the oracle on change plus a 180s heartbeat. |
| Guard program (Rust) | `program/` | Oracle account, per-agent policy account, pause switch, and the `Pull` instruction that checks limits then CPIs into the Subscriptions program. No framework, raw Solana crates. |
| Demo agent | `src/agent/`, `scripts/30-agent.ts` | An autonomous loop that asks the guard to spend. Decisions come from fixed rules (no LLM). A `--stubborn` mode ignores its own limit so the on-chain rejection is visible. |
| Dashboard | `src/dashboard/`, `dashboard/`, `scripts/40-dashboard.ts` | Local page (localhost only) showing the regime, today's budget, oracle freshness and the agent's activity, with owner pause and a crash-simulation switch. |
| TS client + tests | `src/chain/`, `tests/` | Instruction builders and integration tests against devnet. |

### Guard program instructions

| Tag | Instruction | Who can call |
|---|---|---|
| 0 | `InitOracle` | oracle authority |
| 1 | `UpdateOracle` (regime) | oracle authority only |
| 2 | `InitPolicy` | owner |
| 3 | `SetPaused` | owner |
| 4 | `Pull(amount)` | the policy's agent |

### What `Pull` checks (in order)

1. Caller is the policy's agent and signed.
2. Policy and oracle are owned by this program; policy is not paused.
3. Oracle is the one named in the policy.
4. Delegation, owner token account, receiver token account and mint match the policy. The agent cannot substitute them.
5. Effective regime: if the oracle is older than the policy's `max_staleness`, treat it as CRISIS (fail-safe).
6. `limit = base_daily_limit × multiplier(regime)`; today's spend + amount must be ≤ limit (resets each UTC day).
7. State is written first, then the CPI runs; if the CPI fails the whole transaction reverts.

Custom errors: `1 NotAgent, 2 Paused, 3 OracleMismatch, 4 BadAccount, 5 LimitExceeded, 6 BadData, 7 BadAuthority, 8 BadRegime, 9 WrongOwner`.

## Devnet deployment

- Guard program: `GwmpezJpVo6nQUZV9wFNS4c4ctV8zVwojD1Lo6XFzZUP`
- Oracle account (PDA): `HKdABVQSezisE8SrQXWFsofH7nCJFGjFcGxRoCyFzrRx`
- Test token: a self-minted 6-decimal SPL token (not real USDC).

## Run it

Prerequisites: Node 20+, Solana CLI, Rust. On Windows use WSL (Ubuntu) for the Rust build.

```bash
npm install
# 1. wallets: owner, agent, oracle  -> .keys/*.json (never commit)
# 2. fund them with devnet SOL (https://faucet.solana.com)
# 3. create a test token and receiver account
npm run maketoken
# 4. fill .env: RPC_URL (devnet), MINT_ADDRESS, RECEIVER_ATA, GUARD_PROGRAM_ID
# 5. build and deploy the guard (inside WSL)
cd program && cargo build-sbf
solana program deploy target/deploy/regime_guard.so --url devnet --keypair ../.keys/owner.json
# 6. register the owner with the Subscriptions program, create the oracle
npm run init
npm run guardsetup
# 7. run the keeper
npm run keeper
# 8. create the demo agent's allowance and policy (once), then run the agent
npm run agentsetup
npm run agent            # add -- --stubborn to see the chain reject it
# 9. open the dashboard (separate terminal): http://localhost:3000
npm run dashboard
```

Useful scripts: `npm run check` (wallet balances), `npm run pricecheck` (current regime from live prices), `npm run oracle -- CRISIS` (set regime by hand).

### Demo: simulated crash

While the keeper is running, create an empty file named `.demo-crash` in the project folder. The keeper appends a synthetic -10% drop to the live prices, the regime becomes CRISIS, and the guard rejects every pull. Delete the file and the regime returns to CALM after 3 consecutive calm readings. This is a simulation for demonstration; it does not move real markets.

## Tests

| Suite | Count | Command | Runs against |
|---|---|---|---|
| Regime engine unit tests | 17 | `npm run test:unit` | synthetic prices |
| Keeper unit tests | 10 | `npm run testkeeper` | fake price server |
| Demo agent unit tests | 11 | `npm run testagent` | synthetic state |
| Dashboard unit and server tests | 17 | `npm run testdash` | in-process server |
| Guard integration tests | 9 | `npm run testguard` | devnet |
| Guard logic unit tests (Rust) | 12 | `cd program && cargo test` | pure logic |

The devnet tests cover: spend within limit, over-limit rejection, VOLATILE limit at 30%, CRISIS blocking all spend, recovery after CRISIS, stale-oracle fail-safe, wrong-agent rejection, owner pause/unpause, and the agent being unable to pull from the allowance without going through the guard.

## Honest limitations

- **Devnet only.** Not audited. Do not use with real funds.
- **Single oracle authority.** The keeper is a trusted writer. A production version would use multiple signers or an on-chain price source (for example Pyth) with a quorum.
- **Thresholds are heuristic.** The regime cut-offs (for example 15% drawdown, volatility ratio 1.5 / 3) have not been calibrated by a proper historical backtest.
- **One market signal.** The regime comes from a single asset's hourly prices (default SOLUSDT).
- **Rules, not ML.** The engine is deliberately transparent and auditable. News or ML signals could plug in as additional inputs that may only *tighten* limits.
- The daily limit sits on top of the allowance's own cap; both must pass.
- The dashboard's pause and crash-simulation controls are local only (they need the owner key or the keeper's folder) and are not exposed publicly.
- Rejections made during transaction simulation never reach the chain, so they appear in the agent log and dashboard feed but not on the explorer; allowed pulls are real on-chain transactions.

## Roadmap

- Multi-signer or Pyth-based oracle
- Backtested threshold calibration
- Tighten-only news / ML signals
- Mainnet readiness: audit, multisig owner, monitoring

## Built with

Solana Subscriptions & Allowances program (Solana Foundation), `@solana/web3.js`, `@solana/kit`, `@solana/subscriptions`, `@solana/spl-token`, Rust (raw Solana crates), Node.js, TypeScript. Prices come from Binance's public market-data endpoint.

## Repository layout

```
program/       Rust guard program (oracle, policy, pull)
src/regime/    regime engine
src/keeper/    keeper logic
src/agent/     demo agent logic and activity log
src/chain/     instruction builders and address helpers
src/dashboard/ dashboard state and local server
dashboard/     dashboard page
scripts/       runnable scripts (setup, keeper, agent, dashboard)
tests/         unit and integration tests
```

## License

MIT
