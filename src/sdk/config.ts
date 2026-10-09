// Connection config (what an agent needs to spend through RegimeGuard) and the register script's argument parsing.
// Pure functions, no blockchain calls. A connection config never contains a secret key.
import { PublicKey } from '@solana/web3.js';
import { policyPda } from '../chain/guard.ts';

export const DECIMALS = 6; // the demo token has 6 decimals

export interface ConnectionConfig {
  version: 1;
  network: 'devnet';
  rpcUrl: string;
  guardProgram: string;
  oracle: string;
  owner: string;
  agent: string;
  policy: string;
  mint: string;
  receiverAta: string;
  allowanceNonce: string; // a whole number written as text
  decimals: number;
}

const SECRET_WORDS = /secret|private|seed|mnemonic|keypair/i;

function address(name: string, v: unknown): string {
  if (typeof v !== 'string') throw new Error(`config: "${name}" must be an address written as text`);
  try {
    return new PublicKey(v).toBase58();
  } catch {
    throw new Error(`config: "${name}" is not a valid address`);
  }
}

export function buildConnectionConfig(i: {
  rpcUrl: string;
  guardProgram: PublicKey;
  oracle: PublicKey;
  owner: PublicKey;
  agent: PublicKey;
  mint: PublicKey;
  receiverAta: PublicKey;
  nonce: bigint;
  decimals?: number;
}): ConnectionConfig {
  return {
    version: 1,
    network: 'devnet',
    rpcUrl: i.rpcUrl,
    guardProgram: i.guardProgram.toBase58(),
    oracle: i.oracle.toBase58(),
    owner: i.owner.toBase58(),
    agent: i.agent.toBase58(),
    policy: policyPda(i.guardProgram, i.agent).toBase58(),
    mint: i.mint.toBase58(),
    receiverAta: i.receiverAta.toBase58(),
    allowanceNonce: i.nonce.toString(),
    decimals: i.decimals ?? DECIMALS,
  };
}

/** Checks a config read from a file and returns it cleaned up. Throws a clear message when something is wrong. */
export function parseConnectionConfig(input: unknown): ConnectionConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('config: expected a JSON object');
  }
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (SECRET_WORDS.test(k)) {
      throw new Error(`config: the field "${k}" looks like a secret. A connection config must never contain secret keys.`);
    }
  }
  if (o.version !== 1) throw new Error('config: unsupported version (expected 1)');
  if (o.network !== 'devnet') throw new Error('config: only "devnet" is supported for now');
  if (typeof o.rpcUrl !== 'string' || !/^https?:\/\//.test(o.rpcUrl)) throw new Error('config: "rpcUrl" must start with http:// or https://');
  if (typeof o.allowanceNonce !== 'string' || !/^\d+$/.test(o.allowanceNonce)) {
    throw new Error('config: "allowanceNonce" must be a whole number written as text');
  }
  if (typeof o.decimals !== 'number' || !Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 18) {
    throw new Error('config: "decimals" must be a whole number from 0 to 18');
  }
  return {
    version: 1,
    network: 'devnet',
    rpcUrl: o.rpcUrl,
    guardProgram: address('guardProgram', o.guardProgram),
    oracle: address('oracle', o.oracle),
    owner: address('owner', o.owner),
    agent: address('agent', o.agent),
    policy: address('policy', o.policy),
    mint: address('mint', o.mint),
    receiverAta: address('receiverAta', o.receiverAta),
    allowanceNonce: o.allowanceNonce,
    decimals: o.decimals,
  };
}

export interface RegisterArgs {
  agent: PublicKey;
  receiver: PublicKey;
  limitTokens: number; // base daily limit, in whole tokens
  allowanceTokens: number; // total the guard may move before the allowance runs out
  days: number; // how long the allowance lasts
  stalenessSecs: number; // oracle older than this counts as CRISIS
  ownerKeyPath: string;
  oracle: PublicKey | null; // null: work it out from .keys/oracle.json
  out: string; // where to write the connection config
  nonce: bigint | null; // null: pick one (or reuse the one in an existing out file)
}

const FLAGS = new Set(['agent', 'receiver', 'limit', 'allowance', 'days', 'staleness', 'owner-key', 'oracle', 'out', 'nonce']);

function toAddress(name: string, v: string): PublicKey {
  try {
    return new PublicKey(v);
  } catch {
    throw new Error(`--${name}: "${v}" is not a valid address`);
  }
}

function toNumber(name: string, v: string, o: { min: number; max?: number; integer?: boolean }): number {
  const n = Number(v);
  if (!Number.isFinite(n) || v.trim() === '') throw new Error(`--${name}: "${v}" is not a number`);
  if (o.integer && !Number.isInteger(n)) throw new Error(`--${name}: must be a whole number`);
  if (n < o.min || (o.max !== undefined && n > o.max)) {
    throw new Error(`--${name}: must be ${o.max !== undefined ? `between ${o.min} and ${o.max}` : `at least ${o.min}`}`);
  }
  return n;
}

/** Reads `--name value` or `--name=value` flags. Throws a clear message on a missing, unknown or invalid flag. */
export function parseRegisterArgs(argv: string[], env: Record<string, string | undefined>): RegisterArgs {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}" (flags look like --agent <address>)`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!FLAGS.has(name)) throw new Error(`unknown flag --${name}`);
    let value: string;
    if (eq !== -1) {
      value = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value`);
      value = next;
      i++;
    }
    raw.set(name, value);
  }

  const agentText = raw.get('agent');
  if (!agentText) throw new Error('--agent <agent address> is required');
  const receiverText = raw.get('receiver') ?? env.RECEIVER_ATA;
  if (!receiverText) throw new Error('--receiver <token account> is required (or set RECEIVER_ATA in .env)');
  const oracleText = raw.get('oracle') ?? env.ORACLE_ADDRESS;
  const nonceText = raw.get('nonce');
  if (nonceText !== undefined && !/^\d+$/.test(nonceText)) throw new Error('--nonce: must be a whole number');

  const agent = toAddress('agent', agentText);
  return {
    agent,
    receiver: toAddress('receiver', receiverText),
    limitTokens: toNumber('limit', raw.get('limit') ?? '100', { min: 0.000001 }),
    allowanceTokens: toNumber('allowance', raw.get('allowance') ?? '500', { min: 0.000001 }),
    days: toNumber('days', raw.get('days') ?? '3', { min: 1, max: 365, integer: true }),
    stalenessSecs: toNumber('staleness', raw.get('staleness') ?? '600', { min: 60, integer: true }),
    ownerKeyPath: raw.get('owner-key') ?? '.keys/owner.json',
    oracle: oracleText ? toAddress('oracle', oracleText) : null,
    out: raw.get('out') ?? `agent-config.${agent.toBase58().slice(0, 8)}.json`,
    nonce: nonceText !== undefined ? BigInt(nonceText) : null,
  };
}
