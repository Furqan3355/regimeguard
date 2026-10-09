# Owners, agents and policies: how the pieces fit

This page explains who does what, where the money is, what a policy is, and how an agent gets registered. Sections marked **today** work in the repo now. Sections marked **planned** are not built yet.

## 1. Who is involved

| Who | What it is | Holds the owner's money? | Signs |
|---|---|---|---|
| **Owner** | The person or company whose money it is. Has a normal wallet with tokens in it. | Yes (their own token account) | The allowance, the policy, pause / resume |
| **Agent** | Software with its **own key** and its own address, different from the owner's wallet. | **No** | Only the spend request (`Pull`) |
| **Receiver** | The token account that gets paid. The owner picks it when creating the policy. It can be the agent's own token account or a merchant's. | n/a | n/a |
| **Guard program** | The on-chain program that checks every spend request. | No (it only moves tokens inside an allowance) | n/a |
| **Oracle + keeper** | The keeper reads market prices and writes the current regime (CALM, TREND, VOLATILE, CRISIS) to the oracle account. All policies read the same oracle. | No | The keeper's oracle key |

So there are three different addresses in play: the **owner's wallet** (where the money is), the **agent's key** (who asks), and the **receiver** (who gets paid). The agent never holds the owner's funds.

"Money comes from a different wallet than the agent" is exactly the design: the owner's wallet funds everything, and anyone can also top up the owner's token account by sending tokens to it.

## 2. Where the money is

```
Owner's token account  (the money stays here)
        |
        |  allowance: "the guard may move up to X tokens until time T"
        v
Guard program (it is the allowance's delegatee, through a program-derived address)
        ^
        |  Pull(amount), signed by the agent
Agent (own key, no direct access to the money)

On a valid Pull the guard moves tokens:  owner's token account  ->  receiver's token account
```

The allowance (a Fixed Delegation from the Solana Subscriptions program) is a hard outer cap: a total amount and an expiry time. The policy adds the market-aware **daily** limit on top. Both must pass.

## 3. What a policy is

A policy is the rulebook for **one agent**. It is a small on-chain account created by the owner. It stores:

| Field | Meaning |
|---|---|
| owner | Who may pause / resume this agent |
| agent | The only address allowed to spend under this policy |
| oracle | Which oracle (regime feed) this policy trusts |
| mint | Which token it applies to |
| delegator token account | The owner's token account the money comes from |
| receiver token account | The one account that can be paid |
| delegation | The allowance this policy spends from |
| base daily limit | The daily limit in calm markets |
| max staleness | How old the oracle may be (seconds) before it is treated as CRISIS |
| day, spent | How much has been spent today (resets each day) |
| paused | Owner's emergency switch |

The daily limit at any moment is `base daily limit x regime multiplier`:

| Regime | Multiplier |
|---|---|
| CALM | 100% |
| TREND | 80% |
| VOLATILE | 30% |
| CRISIS (or stale oracle) | 0% |

Rules about policies:

- **One policy per agent address.** The policy address is derived from the agent's address.
- **One owner can have many policies**, one for each agent they register.
- The owner cannot change the limit or close a policy after creating it. The program only offers pause and resume (see the gaps below).

## 4. How a policy gets created

**Today:** by script, for the one demo agent. `npm run agentsetup` creates the allowance and the policy using the keys in `.keys/`.

**Planned:** the owner does it on the website with their own wallet. Two transactions are signed in the owner's wallet:

1. **Create the allowance**: token, amount, expiry, delegatee = the guard.
2. **Create the policy**: agent address, receiver, base daily limit, max staleness. The owner pays the small account rent.

The platform never sees the owner's key, and the agent never needs to sign anything at registration time.

## 5. Registering an agent on the website (planned)

An agent cannot register itself, because the money is the owner's and the owner has to sign. What the agent's developer does is give the owner the agent's **address**.

1. The agent (or its developer) creates a key pair and keeps the secret key. It only shares the public address.
2. The owner opens the website and connects their wallet.
3. The owner fills in the form: agent address, token, receiver, base daily limit, allowance amount and expiry.
4. The wallet asks the owner to sign the two transactions from section 4.
5. The website shows a **connection config** with no secrets in it: guard program address, oracle address, owner address, token, receiver, allowance nonce.
6. The agent uses that config (through a small SDK, also planned) to send `Pull` requests.
7. The dashboard lists every agent whose policy has this owner, with live regime, limit used, and activity.

An easy way to start step 2 from the agent's side is a **registration link** that already contains the agent address. The developer sends the link to the owner, the owner opens it, connects a wallet, and only has to approve.

## 6. What happens on every spend request

1. The agent sends `Pull(amount)` and signs with its own key.
2. The guard checks that the signer is the agent named in the policy, and that the policy is not paused.
3. It reads the oracle. If the oracle is older than `max staleness`, the regime is treated as CRISIS.
4. It works out today's limit and checks that `spent today + amount` stays under it.
5. It asks the Subscriptions program to move the tokens inside the allowance, which enforces the allowance's own cap and expiry.
6. If anything fails, nothing moves.

## 7. Who can do what

| Action | Who |
|---|---|
| Create allowance and policy | Owner |
| Pause / resume an agent | Owner |
| Ask to spend | Agent, only inside its policy |
| Write the regime to the oracle | The keeper (oracle key) |
| Change an agent's limit or receiver | Nobody yet (see gaps) |

The platform holds only the oracle key. It holds no owner keys and no agent keys.

## 8. Known gaps

- **No website flow yet** for connecting a wallet or registering an agent (sections 4 and 5 are planned).
- **One receiver per policy.** An agent that pays many merchants needs a list of allowed receivers, which is a change to the Rust program.
- **Policies cannot be edited or closed.** There is no instruction to change the limit or the receiver, or to close a policy.
- **Anyone can create a policy for any agent address**, because the policy address is derived from the agent address alone and the agent does not sign at registration. Someone could register your agent's address first. Fix: include the owner in the policy address, or require the agent's signature.
- **One shared oracle.** All policies trust the keeper's oracle key. See the main README for the production hardening ideas.
- The allowance has an amount and an expiry, so the owner has to renew it when it runs out.
