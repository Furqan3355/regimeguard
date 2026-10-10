// All agents that belong to ONE owner wallet, plus their activity, read straight from the chain.
// Nothing here needs a local log file or a secret key, so it also works for agents run by other people (bring your own agent).
//
//   agents   : every policy account whose owner field (bytes 1..33) equals the owner
//   activity : the guard transactions that touched each policy (spends, rejections, pause, registration)
//
// Limit: a request refused during simulation never reaches the chain, so only rejections that were sent as real
// (failed) transactions show up here. The demo agent's own log (/api/state) still shows its simulated refusals.
import { PublicKey } from '@solana/web3.js';
import type { AccountInfo, ConfirmedSignatureInfo, GetProgramAccountsFilter } from '@solana/web3.js';
import { explainError, fmtTokens } from '../agent/agent.ts';
import { decodeOracle, decodePolicy, ORACLE_LEN, POLICY_LEN, type DecodedOracle, type DecodedPolicy } from '../chain/guard.ts';
import { buildState, type DashboardState } from './state.ts';

const TAG = { InitPolicy: 2, SetPaused: 3, Pull: 4 } as const;
const POLICY_DISC_B58 = '2'; // base58 of the single byte 0x01 (policy discriminator)
const ORACLE_OFFSET = 65; // where a policy stores its oracle address (see program/src/state.rs)

export interface ChainIx {
  programId: string;
  data: Uint8Array;
}
export interface ChainTx {
  signature: string;
  blockTime: number | null;
  err: unknown;
  ixs: ChainIx[];
}
export interface ActivityEvent {
  t: number; // ms
  kind: 'BUY' | 'REJECTED' | 'PAUSED' | 'RESUMED' | 'REGISTERED';
  amount?: string;
  note: string;
  sig: string;
  agent: string;
}

/** Turns one transaction into an activity event, or null when it has no guard instruction. */
export function eventFromTx(tx: ChainTx, guardProgram: string, agent: string): ActivityEvent | null {
  const ix = tx.ixs.find((i) => i.programId === guardProgram && i.data.length > 0);
  if (!ix) return null;
  const t = (tx.blockTime ?? 0) * 1000;
  const base = { t, sig: tx.signature, agent };
  const tag = ix.data[0];

  if (tag === TAG.Pull) {
    const amount = ix.data.length >= 9 ? fmtTokens(Buffer.from(ix.data).readBigUInt64LE(1)) : undefined;
    if (tx.err) return { ...base, kind: 'REJECTED', amount, note: `refused by the guard: ${errorName(tx.err)}` };
    return { ...base, kind: 'BUY', amount, note: 'spend approved on-chain' };
  }
  if (tag === TAG.SetPaused && !tx.err) {
    const paused = ix.data[1] === 1;
    return { ...base, kind: paused ? 'PAUSED' : 'RESUMED', note: paused ? 'owner paused the agent' : 'owner resumed the agent' };
  }
  if (tag === TAG.InitPolicy && !tx.err) return { ...base, kind: 'REGISTERED', note: 'agent registered by the owner' };
  return null;
}

/** meta.err looks like {InstructionError: [index, {Custom: 5}]}. */
function errorName(err: unknown): string {
  try {
    const ie = (err as { InstructionError?: [number, unknown] }).InstructionError;
    const custom = (ie?.[1] as { Custom?: number } | undefined)?.Custom;
    if (typeof custom === 'number') return explainError(`custom program error: 0x${custom.toString(16)}`);
  } catch {
    /* fall through */
  }
  return 'transaction failed';
}

export interface AgentCard {
  agent: string;
  policy: string;
  regime: DashboardState['regime'];
  multiplierPct: number;
  limitToday: string;
  baseLimit: string;
  spent: string;
  remaining: string;
  usedPct: number;
  paused: boolean;
  oracleStale: boolean;
  events: ActivityEvent[];
}
export interface OwnerView {
  owner: string;
  guardProgram: string; // the browser needs it to build a pause/resume transaction
  nowSec: number;
  agents: AgentCard[];
  events: ActivityEvent[]; // all agents merged, newest first
}

export interface PolicyEntry {
  policyAddr: string;
  policy: DecodedPolicy;
  oracle: DecodedOracle;
  events: ActivityEvent[];
}

/** Pure: no network. */
export function buildOwnerView(owner: string, nowSec: number, entries: PolicyEntry[], maxEvents = 30, guardProgram = ''): OwnerView {
  const agents: AgentCard[] = entries.map((e) => {
    const s = buildState({
      nowSec,
      policy: e.policy,
      oracle: e.oracle,
      demoCrash: false,
      events: [],
      addresses: { agent: e.policy.agent, oracle: '', program: '', policy: e.policyAddr },
    });
    return {
      agent: e.policy.agent,
      policy: e.policyAddr,
      regime: s.regime,
      multiplierPct: s.multiplierPct,
      limitToday: s.limitToday,
      baseLimit: s.baseLimit,
      spent: s.spent,
      remaining: s.remaining,
      usedPct: s.usedPct,
      paused: s.paused,
      oracleStale: s.oracleStale,
      events: e.events,
    };
  });
  const events = entries
    .flatMap((e) => e.events)
    .sort((a, b) => b.t - a.t)
    .slice(0, maxEvents);
  return { owner, guardProgram, nowSec, agents, events };
}

/** The few RPC calls this module needs (a real Connection satisfies it, tests pass a fake). */
export interface ChainReader {
  getProgramAccounts(
    programId: PublicKey,
    config: { commitment: 'confirmed'; filters: GetProgramAccountsFilter[] },
  ): Promise<{ pubkey: PublicKey; account: AccountInfo<Buffer> }[]>;
  getMultipleAccountsInfo(keys: PublicKey[], commitment: 'confirmed'): Promise<(AccountInfo<Buffer> | null)[]>;
  getSignaturesForAddress(address: PublicKey, opts: { limit: number }, commitment: 'confirmed'): Promise<ConfirmedSignatureInfo[]>;
  getTransactions(sigs: string[], opts: { maxSupportedTransactionVersion: number; commitment: 'confirmed' }): Promise<(RawTx | null)[]>;
}
/** The part of a web3.js transaction response that we read. */
export interface RawTx {
  blockTime?: number | null;
  meta: { err: unknown; loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } } | null;
  transaction: {
    signatures: string[];
    message: {
      getAccountKeys(o?: { accountKeysFromLookups?: { writable: PublicKey[]; readonly: PublicKey[] } }): { get(i: number): PublicKey | undefined };
      compiledInstructions: { programIdIndex: number; data: Uint8Array }[];
    };
  };
}

function toChainTx(sig: ConfirmedSignatureInfo, raw: RawTx | null): ChainTx | null {
  if (!raw) return null;
  try {
    const keys = raw.transaction.message.getAccountKeys({ accountKeysFromLookups: raw.meta?.loadedAddresses });
    const ixs = raw.transaction.message.compiledInstructions.map((i) => ({
      programId: keys.get(i.programIdIndex)?.toBase58() ?? '',
      data: i.data,
    }));
    return { signature: sig.signature, blockTime: sig.blockTime ?? raw.blockTime ?? null, err: sig.err ?? raw.meta?.err ?? null, ixs };
  } catch {
    return null;
  }
}

export interface ListOptions {
  maxAgents?: number; // default 10
  eventsPerAgent?: number; // default 8
}

export async function listOwnerAgents(
  chain: ChainReader,
  programId: PublicKey,
  owner: PublicKey,
  nowSec: number,
  opts: ListOptions = {},
): Promise<OwnerView> {
  const maxAgents = opts.maxAgents ?? 10;
  const perAgent = opts.eventsPerAgent ?? 8;

  const found = await chain.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [
      { dataSize: POLICY_LEN },
      { memcmp: { offset: 0, bytes: POLICY_DISC_B58 } },
      { memcmp: { offset: 1, bytes: owner.toBase58() } },
    ],
  });

  const policies = found
    .map((f) => {
      try {
        return { addr: f.pubkey, data: f.account.data, policy: decodePolicy(f.account.data) };
      } catch {
        return null;
      }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => a.policy.agent.localeCompare(b.policy.agent))
    .slice(0, maxAgents);

  // oracles (usually just one, shared by all agents)
  const oracleKeys = [...new Set(policies.map((p) => new PublicKey(p.data.subarray(ORACLE_OFFSET, ORACLE_OFFSET + 32)).toBase58()))];
  const oracleInfos = oracleKeys.length ? await chain.getMultipleAccountsInfo(oracleKeys.map((k) => new PublicKey(k)), 'confirmed') : [];
  const oracles = new Map<string, DecodedOracle>();
  oracleKeys.forEach((k, i) => {
    const info = oracleInfos[i];
    let o: DecodedOracle = { authority: '', regime: 255, updatedAt: 0n }; // unreadable oracle = CRISIS (fail-safe)
    if (info && info.data.length === ORACLE_LEN) {
      try {
        o = decodeOracle(info.data);
      } catch {
        /* keep fail-safe */
      }
    }
    oracles.set(k, o);
  });

  const guard = programId.toBase58();
  const entries: PolicyEntry[] = [];
  for (const p of policies) {
    let events: ActivityEvent[] = [];
    try {
      const sigs = await chain.getSignaturesForAddress(p.addr, { limit: perAgent }, 'confirmed');
      const raws = sigs.length ? await chain.getTransactions(sigs.map((s) => s.signature), { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }) : [];
      events = sigs
        .map((s, i) => toChainTx(s, raws[i] ?? null))
        .map((tx) => (tx ? eventFromTx(tx, guard, p.policy.agent) : null))
        .filter((e): e is ActivityEvent => e !== null);
    } catch {
      /* activity is a bonus: a busy RPC must not hide the agent itself */
    }
    const oracleKey = new PublicKey(p.data.subarray(ORACLE_OFFSET, ORACLE_OFFSET + 32)).toBase58();
    entries.push({ policyAddr: p.addr.toBase58(), policy: p.policy, oracle: oracles.get(oracleKey)!, events });
  }
  return buildOwnerView(owner.toBase58(), nowSec, entries, 30, guard);
}
