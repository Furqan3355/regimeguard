# RegimeGuard

**Market-aware spending limits for autonomous agents on Solana, enforced on-chain.**

An agent receives an allowance. RegimeGuard makes that allowance *shrink automatically when the market turns dangerous* (volatile, crash) and restore when conditions calm down. The limit is enforced by a Solana program, so the agent cannot bypass it, even if its own code is wrong or compromised.

Built for the Colosseum Crypto World's Fair hackathon (Solana track). Runs on **devnet**.

| | |
|---|---|
| Live demo | `<add link>` |
| Demo video | `<add link>` |
| Guard program (devnet) | `GwmpezJpVo6nQUZV9wFNS4c4ctV8zVwojD1Lo6XFzZUP` |
| Oracle account (devnet) | `HKdABVQSezisE8SrQXWFsofH7nCJFGjFcGxRoCyFzrRx` |
| Demo owner wallet | `DGkUcC9G3PyKwi7TMjwSTPeJWbrCduHccagnbp6CwMqW` |

---

## Contents

1. [The problem](#the-problem)
2. [The solution](#the-solution)
3. [How the regime oracle works](#how-the-regime-oracle-works)
4. [Architecture](#architecture)
5. [The website](#the-website)
6. [Bring your own agent](#bring-your-own-agent)
7. [Read-only API](#read-only-api)
8. [Run it yourself](#run-it-yourself)
9. [Tests](#tests)
10. [Security model and honest limitations](#security-model-and-honest-limitations)
11. [Product vision: RegimeGuard as a service](#product-vision-regimeguard-as-a-service)
12. [Roadmap](#roadmap)
13. [Repository layout](#repository-layout)

---

## The problem

People hesitate to give AI agents and trading bots real money. The usual safeguard is a static cap ("at most 100 tokens per day"). A static cap is blind to the market: it allows the agent to spend the full amount in the middle of a crash.

## The solution

RegimeGuard sits between the agent and the money. Each agent has an on-chain **policy** (owner, receiver, daily limit, staleness rule). A **keeper** writes the current market **regime** to an on-chain **oracle** account. On every spend the guard program reads the regime and applies a multiplier to the daily limit.

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
| CRISIS | crash, shock, or stale data | 0% |

### Why Solana

- Uses Solana's native **Subscriptions & Allowances** program (`De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, Fixed Delegation).
- The allowance's *delegatee* is a **program-derived address (PDA) owned by RegimeGuard**, not the agent. The guard signs the transfer through a CPI (`invoke_signed`). The agent has no direct path to the funds.
- Cheap, frequent oracle updates make a live regime feed practical.

---

## How the regime oracle works

The oracle is **rule-based and transparent**. There is no machine learning and no LLM in the decision.

1. Every 60 seconds the **keeper** fetches hourly candles for one market (default `SOLUSDT`, configurable with `SYMBOL`) from a public market-data endpoint (no API key).
2. The regime engine (`src/regime/engine.ts`, pure functions) computes four measures:
   - **volRatio**: volatility over the last 24 hours compared with the longer-term normal
   - **drawdown**: fall from the highest price of the last 7 days
   - **shockZ**: how unusual the largest recent move is (z-score over the last hours)
   - **trend**: difference between a short and a long moving average (EMA 20 / EMA 50)
3. Fixed thresholds map the measures to a regime. CRISIS: drawdown 15% or more, volatility ratio 3 or more, or a shock of 6 sigma or more. VOLATILE: drawdown 8%, ratio 1.5, or shock 3.5. TREND: trend beyond 0.5%. Otherwise CALM.
4. **Hysteresis:** risk goes up immediately, but the regime comes back down only after 3 consecutive calmer readings, so limits do not flicker.
5. The keeper writes the regime to the oracle account when it changes, plus a heartbeat every 180 seconds.
6. If the oracle is older than the policy's `max_staleness`, the guard treats the regime as **CRISIS** (fail-safe). If the keeper stops, spending stops.

The thresholds are heuristic starting values and have not yet been calibrated by a historical backtest (see [limitations](#security-model-and-honest-limitations)).

---

## Architecture

| Part | Where | What it does |
|---|---|---|
| Regime engine | `src/regime/engine.ts` | Pure functions: measures and thresholds above. |
| Keeper | `src/keeper/keeper.ts`, `scripts/21-keeper.ts` | Fetches prices, computes the regime, writes the oracle. |
| Guard program (Rust) | `program/` | Oracle account, per-agent policy account, pause switch, and the `Pull` instruction that checks limits then calls the Subscriptions program. Raw Solana crates, no framework. |
| TypeScript SDK | `src/sdk/` | `RegimeGuardAgent` for agents: `fromConfig`, `state`, `pull`. |
| Demo agent | `src/agent/`, `scripts/30-agent.ts` | Autonomous loop with fixed rules. `--stubborn` mode ignores its own limit so the on-chain rejection is visible. |
| Dashboard API | `src/dashboard/`, `scripts/40-dashboard.ts` | Backend that reads the chain: demo agent state, and all agents of an owner. |
| Website | `web/` | Next.js site: live demo, **Your agents** (wallet view), developer panel. |
| Client and tests | `src/chain/`, `tests/` | Instruction builders and tests. |

### Guard program instructions

| Tag | Instruction | Who can call |
|---|---|---|
| 0 | `InitOracle` | oracle authority |
| 1 | `UpdateOracle` (regime) | oracle authority only |
| 2 | `InitPolicy` | owner |
| 3 | `SetPaused` | owner |
| 4 | `Pull(amount)` | the policy's agent |

### What `Pull` checks (in order)

1. The caller is the policy's agent and signed.
2. Policy and oracle are owned by this program, and the policy is not paused.
3. The oracle is the one named in the policy.
4. Delegation, owner token account, receiver token account and mint match the policy. The agent cannot substitute them.
5. Effective regime: an oracle older than `max_staleness` counts as CRISIS.
6. `limit = base_daily_limit × multiplier(regime)`. Today's spend plus the amount must be at most the limit (resets each UTC day).
7. State is written first, then the CPI runs. If the CPI fails, the whole transaction reverts.

Custom errors: `1 NotAgent, 2 Paused, 3 OracleMismatch, 4 BadAccount, 5 LimitExceeded, 6 BadData, 7 BadAuthority, 8 BadRegime, 9 WrongOwner`.

---

## The website

The site has three parts:

- **Live demo.** The regime, today's budget, oracle freshness and the demo agent's activity.
- **Your agents.** Connect a Solana wallet (Phantom) or paste any wallet address to see every agent registered by that wallet: regime, limit now, spent, remaining, paused, and the combined **on-chain activity of all of them** (approved spends, refusals by the guard, pause, resume, registration). Reading is public chain data, so connecting only to look needs no SOL and sends no transaction.
- **Owner controls.** When the connected wallet is the owner, each agent card has **Pause / Resume**. This is one transaction signed in the owner's own wallet; the chain accepts it only from the policy's owner. Set the wallet to **Devnet**.

The site also has a **Connect your own agent** panel that builds the exact registration command from an agent address and limits.

---

## Bring your own agent

You do not need the demo agent. Any program with its own key can spend through RegimeGuard. Two roles (they can be one person):

- **The owner** holds the money and registers the agent. The owner signs, on their own machine.
- **The agent** has its own, different key and only asks to spend. Its secret key never leaves its machine and is never sent to RegimeGuard or the website.

```bash
# 1. the agent's identity (secret file + public address)
npm run newagent

# 2. a little devnet SOL for fees: the agent address and the owner (https://faucet.solana.com)

# 3. the owner registers the agent's PUBLIC address with a policy
npm run register -- --agent <agent address> --limit 100 --allowance 500 --days 3

# 4. the agent spends through the SDK
npm run example -- <connection config file> <agent key file>
```

Registration writes a connection config file. It contains addresses and the RPC URL, so check it before sharing and replace the RPC URL if it contains a private API key.

```ts
const agent = await RegimeGuardAgent.fromConfig(config, key);
const s = await agent.state();           // what is allowed right now
await agent.pull(agent.tokensToUnits(1)); // the guard checks it again on-chain
```

**Who needs SOL.** Only for network fees: the agent address (it pays for each spend) and the owner (one-time registration). The money the agent spends is the owner's tokens, not SOL.

Full guide: [`docs/BRING-YOUR-OWN-AGENT.md`](docs/BRING-YOUR-OWN-AGENT.md). A browser-based registration form is planned.

---

## Read-only API

Public and read-only. It returns only data that is already public on the chain, needs no key, and can never spend or pause.

| Endpoint | Returns |
|---|---|
| `GET /api/agents?owner=<wallet>` | Every agent of that owner (regime, limit now, spent, remaining, paused) and their recent on-chain activity |
| `GET /api/state` | The demo agent's live state and activity log |
| `GET /api/blockhash` | A recent blockhash, so the browser can build the owner's pause or resume transaction without holding the RPC key |

---

## Run it yourself

Prerequisites: Node 20+ (Node 24 recommended), Solana CLI and Rust for building the program. On Windows use WSL for the Rust build.

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
# 7. run the keeper (keep it running: a stale oracle means CRISIS)
npm run keeper
# 8. create the demo agent's allowance and policy (once), then run the agent
npm run agentsetup
npm run agent            # add -- --stubborn to see the chain reject it
# 9. the dashboard API (separate terminal), port 3000
npm run dashboard
# 10. the website (separate terminal), port 3001
cd web && npx pnpm@10 install --frozen-lockfile && npx pnpm@10 exec next dev -p 3001
```

Useful scripts: `npm run check` (balances), `npm run pricecheck` (current regime from live prices), `npm run oracle -- CRISIS` (set the regime by hand), `npm run pubkeys` (public addresses).

### Demo tool: simulated crash (presentation only)

This is **not a product feature**. It exists only so a live presentation can show the guard reacting without waiting for a real crash. In normal operation the keeper uses real market prices only.

While the keeper runs locally, create an empty file named `.demo-crash` in the project folder. The keeper adds a synthetic 10% drop to the live prices, the regime becomes CRISIS, and the guard rejects every pull. Delete the file and the regime returns to CALM after 3 consecutive calm readings. The switch is a local tool; it is disabled in the website's public read-only mode, and it does not move real markets.

---

## Tests

| Suite | Tests | Command | Runs against |
|---|---|---|---|
| Regime engine | 17 | `npm run test:unit` | synthetic prices |
| Keeper | 10 | `npm run testkeeper` | fake price server |
| Demo agent | 11 | `npm run testagent` | synthetic state |
| SDK and registration | 16 | `npm run testsdk` | offline |
| Dashboard, API, multi-agent listing | 27 | `npm run testdash` | in-process server, fake chain |
| Guard integration | 9 | `npm run testguard` | devnet |
| Guard logic (Rust) | 12 | `cd program && cargo test` | pure logic |

The devnet tests cover: spend within the limit, over-limit rejection, the VOLATILE limit at 30%, CRISIS blocking all spending, recovery after CRISIS, the stale-oracle fail-safe, wrong-agent rejection, owner pause and unpause, and the agent being unable to pull from the allowance without going through the guard.

---

## Security model and honest limitations

**What the design guarantees.** The agent never holds the funds and has no direct path to them. Every spend is checked on-chain against the policy and the live regime. A compromised or buggy agent is limited to what the policy allows. Only the owner can pause.

**Limitations of this version:**


- **Single oracle authority.** The keeper is a trusted writer. A production version would use multiple signers or an on-chain price source (for example Pyth) with a quorum.
- **One market signal.** The regime comes from one asset's hourly prices (default SOL), and all agents sharing an oracle share its regime. Other markets (Bitcoin, Ethereum, stock indices, macro events) are not used yet but in future will be in this regime to get smoth results; see the roadmap.
- **Oracle availability.** If the keeper stops, agents are blocked after the staleness window. This is the fail-safe by design, and also a dependency.
- **One receiver per policy**, and a policy's limit and receiver cannot be changed once created. Register a new agent address to change them.
- **Registration is a command**, signed by the owner. The website is read-only except for the owner's pause and resume.
- **Wallet connection identifies an address; it does not hide data.** Everything shown is public on the chain.
- **Activity shows transactions that reached the chain.** A request refused during simulation never reaches the chain, so for the demo agent it appears only in its own log.
- The policy address depends only on the agent address, so use a fresh agent key per owner and register it straight away.

---

## Product vision: RegimeGuard as a service

The hackathon build proves the core idea on devnet: an on-chain guard whose limits follow the market. The product we are heading towards has two layers.

**Layer 1: the open on-chain guard (free, open source).** The Solana program, the SDK and the website. Anyone can register an agent and get market-aware spending limits that the chain enforces. This is the trust layer, so it stays open and inspectable.

**Layer 2: managed services around it (planned, not built yet).** What teams running autonomous agents with real budgets would pay for:

| Service | What it gives the customer |
|---|---|
| **Regime Oracle as a service** | A hosted, always-on keeper and a dedicated oracle per customer, so their agents depend on an SLA instead of a shared demo feed. Choose the assets and thresholds that match their strategy. |
| **Alerts and webhooks** | A message (Slack, Telegram, webhook) when the regime changes, when an agent is refused, or when a budget is nearly used. |
| **Monitoring and analytics** | A dashboard across all of a team's agents: spend history, refusals, how often each regime was active, exportable audit logs. |
| **Team controls** | Multiple owners or a multisig owner, roles (who can pause, who can register), and approval flows for raising limits. |
| **API and SDK access** | Keys, higher rate limits and support for the read API and a published SDK package. |

**Possible pricing model (a plan, not a commitment):** free for the open guard and a shared public oracle; paid tiers by number of agents or policies, dedicated oracle, alerts and support. Pricing is not decided and nothing in this repository charges anyone.

**Who it is for:** teams that run trading, payment or treasury agents, agent frameworks that want a safety layer for their users, and DAOs that delegate spending to bots.

**Why the architecture fits this:** the oracle is already a separate account referenced by each policy, so giving each customer their own oracle needs no change to the guard. An oracle that stops updating makes its agents fail safe, which is also what makes a service-level agreement meaningful.

---

## Roadmap

**Built in this hackathon:** guard program, regime engine and keeper, SDK, demo agent, owner agent listing and on-chain activity, wallet connect, wallet-signed pause and resume, bring-your-own-agent registration by command, read-only API.

**Next (short term)**
- Browser-based agent registration with wallet signing (two transactions)
- Publish the SDK as a package
- Backtest and calibrate the regime thresholds on historical data
- Bitcoin and Ethereum as additional tighten-only signals: they lead the crypto market, so if either is VOLATILE or CRISIS the combined regime is at least that, and a calm one never loosens anything
- Alerts: regime changes and refused spends

**Then (service layer)**
- Per-customer oracles run by a hosted keeper, with uptime monitoring
- Multi-source oracle (for example Pyth) with several signers instead of a single trusted writer
- Wider market signals (stock indices, volatility indices, macro and news events, always tighten-only) and per-customer assets and thresholds
- Team features: multisig owner, roles, audit log export
- Policies beyond a daily amount: several receivers, per-transaction caps, time windows

**Later**
- Tighten-only news and ML signals (they may lower limits, never raise them)
- Security audit, then a mainnet release with a real token

---

## Repository layout

```
program/        Rust guard program (oracle, policy, pull)
src/regime/     regime engine
src/keeper/     keeper logic
src/sdk/        SDK for agents (RegimeGuardAgent)
src/agent/      demo agent logic and activity log
src/chain/      instruction builders and address helpers
src/dashboard/  dashboard state, owner agent listing, server
web/            website (Next.js)
scripts/        runnable scripts (setup, keeper, agent, register, dashboard)
examples/       a complete small agent
docs/           bring-your-own-agent guide
tests/          unit and integration tests
```

## Built with

Solana Subscriptions & Allowances program (Solana Foundation), `@solana/web3.js`, `@solana/kit`, `@solana/subscriptions`, `@solana/spl-token`, Rust (raw Solana crates), Node.js, TypeScript, Next.js. Prices come from a public market-data endpoint.

## License

MIT