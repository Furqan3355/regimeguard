# Bring your own agent

You do not have to use the demo agent. Any agent that has its own key can spend through RegimeGuard. This page shows how the owner registers an agent and how the agent then spends. Everything here runs on **Solana devnet**.

Two people are involved (they can be the same human):

- **The owner** holds the money and registers the agent. The owner signs.
- **The agent** has its own key and only asks to spend. It never holds the owner's money.

## 1. Before you start

**The agent** needs a key of its own, different from the owner's wallet. Create one and keep the secret file safe:

```bash
solana-keygen new --outfile agent-key.json
solana address -k agent-key.json        # the public address, safe to share
```

Then it needs:

- a little devnet SOL at that address, to pay network fees (https://faucet.solana.com)

**The owner** needs:

- the owner key in `.keys/owner.json` and a `.env` with `MINT_ADDRESS`, `GUARD_PROGRAM_ID` (and `RPC_URL` if you do not use the default devnet RPC), as in the main README
- tokens in the owner's token account: that is where the money comes from
- the **receiver**: the token account that gets paid. It must already exist. It can be the agent's own token account or any other account.

## 2. The owner registers the agent

Only the agent's public address is needed, never its secret key.

```bash
npm run register -- --agent <agent address> --receiver <receiver token account> --limit 100 --allowance 500 --days 3
```

| Flag | Meaning | Default |
|---|---|---|
| `--agent` | The agent's public address | required |
| `--receiver` | The token account that gets paid | `RECEIVER_ATA` from `.env` |
| `--limit` | Daily limit in calm markets, in tokens. It shrinks automatically in risky markets | 100 |
| `--allowance` | Total tokens the guard may move before the allowance runs out | 500 |
| `--days` | How long the allowance lasts | 3 |
| `--staleness` | Seconds before an old oracle counts as CRISIS | 600 |
| `--owner-key` | Owner key file | `.keys/owner.json` |
| `--oracle` | Oracle address | worked out from `.keys/oracle.json` |
| `--out` | Where to write the connection config | `agent-config.<first 8 characters of the agent address>.json` |

It does two things, both signed by the owner: it creates the **allowance** (the guard may move up to `--allowance` tokens until it expires) and the agent's **policy** (the agent's rulebook). Then it writes a **connection config** file.

The connection config contains addresses only, no secrets, so it is safe to send to whoever runs the agent. Running the command again for the same agent changes nothing.

One policy exists per agent address, and a policy cannot be changed or closed once created. If the address was already registered by someone else, the command stops with a clear message.

## 3. The agent spends

Give the agent the connection config file and let it use the SDK:

```ts
import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { GuardRejectionError, RegimeGuardAgent } from './src/sdk/index.ts';

const config = JSON.parse(fs.readFileSync('agent-config.XXXXXXXX.json', 'utf8'));
const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('agent-key.json', 'utf8'))));
const agent = await RegimeGuardAgent.fromConfig(config, key);

const s = await agent.state();       // regime, paused, limit, spent, remaining (in the token's smallest unit)
const amount = agent.tokensToUnits(1);
if (s.remaining >= amount) {
  try {
    const signature = await agent.pull(amount);   // the guard checks everything again on-chain
    console.log('spent, transaction', signature);
  } catch (e) {
    if (e instanceof GuardRejectionError) console.log('rejected:', e.reason);   // for example LimitExceeded, Paused
  }
}
```

What the SDK gives you:

| Call | What it does |
|---|---|
| `RegimeGuardAgent.fromConfig(config, key)` | Checks the config and that the key matches the registered agent. Sends nothing. |
| `agent.state()` | Reads the policy and the oracle and tells you what may still be spent today. |
| `agent.pull(amount)` | Sends a spend request. Throws `GuardRejectionError` with the guard's reason if refused. |
| `agent.pullInstruction(amount)` | The unsigned instruction, if you build your own transactions. |
| `agent.tokensToUnits(n)` / `unitsToTokens(u)` | Convert whole tokens and the smallest unit. |

A complete small agent is in `examples/my-agent.ts`:

```bash
npm run example -- agent-config.XXXXXXXX.json agent-key.json
```

Checking `state()` first is polite but not required for safety: the guard enforces the limit on-chain whatever the agent does. An agent that ignores its limit simply gets rejected.

## 4. What the guard does on every spend

It checks that the signer is the registered agent and the policy is not paused, reads the oracle (a stale oracle counts as CRISIS), works out today's limit (`limit x regime multiplier`) and checks that today's spending stays under it, then asks the Subscriptions program to move the tokens inside the allowance. If any check fails, nothing moves.

## 5. Limits of this version

- Registration is a command run by the owner. A website with wallet connection and an "Add agent" form is planned.
- One receiver per policy. An agent that pays many different accounts needs a receiver list, which would be a change to the Rust program.
- A policy's limit and receiver cannot be changed after it is created. To change them, register a new agent address.
- The policy address depends only on the agent address, so someone else could register your agent's address before you. Generate a fresh agent key per owner and register it straight away.
- Devnet only, not audited.
