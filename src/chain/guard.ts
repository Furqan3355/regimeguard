// Helpers that build RegimeGuard program instructions (web3.js).
// This must match the layout in the Rust program (program/src/state.rs).
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

export const SUBS_PROGRAM = new PublicKey('De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44');
export const POLICY_LEN = 259;
export const ORACLE_LEN = 43;

export const REGIME = { CALM: 0, TREND: 1, VOLATILE: 2, CRISIS: 3 } as const;
export type RegimeName = keyof typeof REGIME;

const TAG = { InitOracle: 0, UpdateOracle: 1, InitPolicy: 2, SetPaused: 3, Pull: 4 } as const;

const u64 = (v: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

export const guardPda = (programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('guard')], programId)[0];

export const oraclePda = (programId: PublicKey, authority: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('oracle'), authority.toBuffer()], programId)[0];

export const policyPda = (programId: PublicKey, agent: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from('policy'), agent.toBuffer()], programId)[0];

export function ixInitOracle(programId: PublicKey, authority: PublicKey, lamports: bigint) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: oraclePda(programId, authority), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([TAG.InitOracle]), u64(lamports)]),
  });
}

export function ixUpdateOracle(programId: PublicKey, authority: PublicKey, regime: number) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: oraclePda(programId, authority), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([TAG.UpdateOracle, regime]),
  });
}

export interface PolicyParams {
  agent: PublicKey;
  oracle: PublicKey;
  mint: PublicKey;
  delegatorAta: PublicKey;
  receiverAta: PublicKey;
  delegation: PublicKey;
  baseDailyLimit: bigint;
  maxStalenessSecs: bigint;
}

export function ixInitPolicy(
  programId: PublicKey,
  owner: PublicKey,
  lamports: bigint,
  p: PolicyParams,
) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: policyPda(programId, p.agent), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from([TAG.InitPolicy]),
      u64(lamports),
      p.agent.toBuffer(),
      p.oracle.toBuffer(),
      p.mint.toBuffer(),
      p.delegatorAta.toBuffer(),
      p.receiverAta.toBuffer(),
      p.delegation.toBuffer(),
      u64(p.baseDailyLimit),
      u64(p.maxStalenessSecs),
    ]),
  });
}

export function ixSetPaused(programId: PublicKey, owner: PublicKey, agent: PublicKey, paused: boolean) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: policyPda(programId, agent), isSigner: false, isWritable: true },
    ],
    data: Buffer.from([TAG.SetPaused, paused ? 1 : 0]),
  });
}

export interface PullAccounts {
  delegationPda: PublicKey;
  subscriptionAuthority: PublicKey;
  delegatorAta: PublicKey;
  receiverAta: PublicKey;
  tokenMint: PublicKey;
  tokenProgram: PublicKey;
  eventAuthority: PublicKey;
}

/** policy: by default the agent's own policy. Tests can override it to pass a wrong policy. */
export function ixPull(
  programId: PublicKey,
  agent: PublicKey,
  oracle: PublicKey,
  a: PullAccounts,
  amount: bigint,
  policy: PublicKey = policyPda(programId, agent),
) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: agent, isSigner: true, isWritable: false },
      { pubkey: policy, isSigner: false, isWritable: true },
      { pubkey: oracle, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SUBS_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: a.delegationPda, isSigner: false, isWritable: true },
      { pubkey: a.subscriptionAuthority, isSigner: false, isWritable: false },
      { pubkey: a.delegatorAta, isSigner: false, isWritable: true },
      { pubkey: a.receiverAta, isSigner: false, isWritable: true },
      { pubkey: a.tokenMint, isSigner: false, isWritable: false },
      { pubkey: a.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: guardPda(programId), isSigner: false, isWritable: false },
      { pubkey: a.eventAuthority, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([TAG.Pull]), u64(amount)]),
  });
}

export interface DecodedPolicy {
  owner: string;
  agent: string;
  baseDailyLimit: bigint;
  maxStalenessSecs: bigint;
  day: bigint;
  spent: bigint;
  paused: boolean;
}

export function decodePolicy(d: Buffer): DecodedPolicy {
  if (d.length !== POLICY_LEN || d[0] !== 1) throw new Error('not a policy account');
  return {
    owner: new PublicKey(d.subarray(1, 33)).toBase58(),
    agent: new PublicKey(d.subarray(33, 65)).toBase58(),
    baseDailyLimit: d.readBigUInt64LE(225),
    maxStalenessSecs: d.readBigUInt64LE(233),
    day: d.readBigInt64LE(241),
    spent: d.readBigUInt64LE(249),
    paused: d[257] === 1,
  };
}

export interface DecodedOracle {
  authority: string;
  regime: number;
  updatedAt: bigint;
}

export function decodeOracle(d: Buffer): DecodedOracle {
  if (d.length !== ORACLE_LEN || d[0] !== 2) throw new Error('not an oracle account');
  return {
    authority: new PublicKey(d.subarray(1, 33)).toBase58(),
    regime: d[33],
    updatedAt: d.readBigInt64LE(34),
  };
}
