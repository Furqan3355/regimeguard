// RegimeGuard SDK for an agent. Give it the connection config the owner got when registering the agent,
// plus the agent's own key, and it can read the agent's budget and send spend requests through the guard.
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { decodeOracle, decodePolicy, ixPull, policyPda, type PullAccounts } from '../chain/guard.ts';
import { derivePullAccounts } from '../chain/subs.ts';
import { budget, currentRegime, explainError } from '../agent/agent.ts';
import type { Regime } from '../regime/engine.ts';
import { parseConnectionConfig, type ConnectionConfig } from './config.ts';

export * from './config.ts';

export interface AgentState {
  regime: Regime; // what the guard enforces right now
  paused: boolean;
  limit: bigint; // today's limit, in the token's smallest unit
  spent: bigint; // spent so far today
  remaining: bigint; // what can still be spent today (0 while paused)
  oracleAgeSecs: number | null;
  oracleStale: boolean;
}

/** The guard (or the network) refused a spend request. `reason` is the guard's error name, for example LimitExceeded or Paused. */
export class GuardRejectionError extends Error {
  readonly reason: string;
  constructor(reason: string, cause: unknown) {
    super(`The guard did not allow this spend: ${reason}`, { cause });
    this.name = 'GuardRejectionError';
    this.reason = reason;
  }
}

export class RegimeGuardAgent {
  readonly config: ConnectionConfig;
  readonly agent: Keypair;
  readonly policyAddress: PublicKey;
  readonly oracleAddress: PublicKey;
  readonly connection: Connection;
  private readonly programId: PublicKey;
  private readonly accounts: PullAccounts;

  private constructor(config: ConnectionConfig, agent: Keypair, connection: Connection, accounts: PullAccounts) {
    this.config = config;
    this.agent = agent;
    this.connection = connection;
    this.programId = new PublicKey(config.guardProgram);
    this.policyAddress = policyPda(this.programId, agent.publicKey);
    this.oracleAddress = new PublicKey(config.oracle);
    this.accounts = accounts;
  }

  /** `config` is the parsed JSON of the connection config file. Nothing is sent over the network here. */
  static async fromConfig(config: unknown, agent: Keypair, opts: { connection?: Connection } = {}): Promise<RegimeGuardAgent> {
    const c = parseConnectionConfig(config);
    if (c.agent !== agent.publicKey.toBase58()) {
      throw new Error(`This config is for agent ${c.agent}, but the key you passed belongs to ${agent.publicKey.toBase58()}.`);
    }
    const programId = new PublicKey(c.guardProgram);
    if (policyPda(programId, agent.publicKey).toBase58() !== c.policy) {
      throw new Error('The "policy" address in the config does not match this agent and guard program. The config may be damaged.');
    }
    const accounts = await derivePullAccounts({
      programId,
      owner: new PublicKey(c.owner),
      mint: new PublicKey(c.mint),
      receiverAta: new PublicKey(c.receiverAta),
      nonce: BigInt(c.allowanceNonce),
    });
    return new RegimeGuardAgent(c, agent, opts.connection ?? new Connection(c.rpcUrl, 'confirmed'), accounts);
  }

  /** Whole tokens to the token's smallest unit, for example 1.5 -> 1500000 (6 decimals). */
  tokensToUnits(tokens: number): bigint {
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error('tokens must be a number that is zero or more');
    return BigInt(Math.round(tokens * 10 ** this.config.decimals));
  }

  unitsToTokens(units: bigint): number {
    return Number(units) / 10 ** this.config.decimals;
  }

  /** Reads the policy and the oracle from the chain and works out what this agent may still spend today. */
  async state(): Promise<AgentState> {
    const [policyInfo, oracleInfo] = await this.connection.getMultipleAccountsInfo(
      [this.policyAddress, this.oracleAddress],
      'confirmed',
    );
    if (!policyInfo) throw new Error('No policy found for this agent. The owner has to register it first.');
    if (!oracleInfo) throw new Error('Oracle account not found. Check the "oracle" address in the config.');
    const policy = decodePolicy(policyInfo.data);
    const oracle = decodeOracle(oracleInfo.data);
    const nowSec = Math.floor(Date.now() / 1000);
    const regime = currentRegime(oracle, policy, nowSec);
    const b = budget(policy, regime, nowSec);
    const age = oracle.updatedAt > 0n ? nowSec - Number(oracle.updatedAt) : null;
    return {
      regime,
      paused: policy.paused,
      limit: b.limit,
      spent: b.spent,
      remaining: policy.paused ? 0n : b.remaining,
      oracleAgeSecs: age,
      oracleStale: age === null || age < 0 || BigInt(age) > policy.maxStalenessSecs,
    };
  }

  /** The spend request as a Solana instruction (unsigned, not sent). Useful if you build your own transactions. */
  pullInstruction(amount: bigint): TransactionInstruction {
    if (amount <= 0n) throw new Error('amount must be greater than zero');
    return ixPull(this.programId, this.agent.publicKey, this.oracleAddress, this.accounts, amount, this.policyAddress);
  }

  /** Sends a spend request (amount in the token's smallest unit) and returns the transaction signature. */
  async pull(amount: bigint): Promise<string> {
    const tx = new Transaction().add(this.pullInstruction(amount));
    try {
      return await sendAndConfirmTransaction(this.connection, tx, [this.agent], { commitment: 'confirmed' });
    } catch (e) {
      throw new GuardRejectionError(explainError((e as Error).message), e);
    }
  }
}
