import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { eventFromTx, listOwnerAgents, type ChainReader, type RawTx } from '../src/dashboard/agents.ts';
import { ORACLE_LEN, POLICY_LEN } from '../src/chain/guard.ts';

const programId = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const otherOwner = Keypair.generate().publicKey;
const oracleKey = Keypair.generate().publicKey;
const NOW = 1_800_000_000;

function policyData(o: PublicKey, agent: PublicKey, base: bigint, spent: bigint): Buffer {
  const d = Buffer.alloc(POLICY_LEN);
  d[0] = 1;
  o.toBuffer().copy(d, 1);
  agent.toBuffer().copy(d, 33);
  oracleKey.toBuffer().copy(d, 65);
  d.writeBigUInt64LE(base, 225);
  d.writeBigUInt64LE(600n, 233);
  d.writeBigInt64LE(BigInt(Math.floor(NOW / 86400)), 241);
  d.writeBigUInt64LE(spent, 249);
  return d;
}
function oracleData(regime: number, updatedAt: number): Buffer {
  const d = Buffer.alloc(ORACLE_LEN);
  d[0] = 2;
  d[33] = regime;
  d.writeBigInt64LE(BigInt(updatedAt), 34);
  return d;
}
const acct = (data: Buffer) => ({ data, executable: false, lamports: 1, owner: programId });
const pullData = (tokens: bigint) => {
  const b = Buffer.alloc(9);
  b[0] = 4;
  b.writeBigUInt64LE(tokens * 1_000_000n, 1);
  return b;
};

const agentA = Keypair.generate().publicKey;
const agentB = Keypair.generate().publicKey;
const agentX = Keypair.generate().publicKey; // belongs to someone else
const policies = [
  { pubkey: Keypair.generate().publicKey, account: acct(policyData(owner, agentA, 100_000_000n, 30_000_000n)) },
  { pubkey: Keypair.generate().publicKey, account: acct(policyData(owner, agentB, 50_000_000n, 0n)) },
  { pubkey: Keypair.generate().publicKey, account: acct(policyData(otherOwner, agentX, 10_000_000n, 0n)) },
];

function rawTx(data: Buffer, err: unknown = null): RawTx {
  return {
    blockTime: NOW - 10,
    meta: { err },
    transaction: {
      signatures: ['s'],
      message: {
        getAccountKeys: () => ({ get: (i: number) => (i === 0 ? programId : undefined) }),
        compiledInstructions: [{ programIdIndex: 0, data }],
      },
    },
  };
}

const fakeChain = (oracle: Buffer | null): ChainReader => ({
  // the real RPC applies the memcmp filter; the fake does the same by hand
  getProgramAccounts: async (_p, cfg) => {
    const m = cfg.filters.find((f) => 'memcmp' in f && f.memcmp.offset === 1) as { memcmp: { bytes: string } };
    return policies.filter((p) => new PublicKey(p.account.data.subarray(1, 33)).toBase58() === m.memcmp.bytes);
  },
  getMultipleAccountsInfo: async (keys) => keys.map(() => (oracle ? acct(oracle) : null)),
  getSignaturesForAddress: async (addr) =>
    addr.equals(policies[0].pubkey)
      ? [
          { signature: 'ok1', slot: 1, err: null, memo: null, blockTime: NOW - 10 },
          { signature: 'bad1', slot: 1, err: { InstructionError: [0, { Custom: 5 }] }, memo: null, blockTime: NOW - 5 },
        ]
      : [],
  getTransactions: async (sigs) => sigs.map((s) => (s === 'ok1' ? rawTx(pullData(5n)) : rawTx(pullData(900n), { InstructionError: [0, { Custom: 5 }] }))),
});

test('lists only the agents of the given owner, with their budgets', async () => {
  const v = await listOwnerAgents(fakeChain(oracleData(0, NOW - 5)), programId, owner, NOW);
  assert.equal(v.agents.length, 2);
  assert.equal(v.guardProgram, programId.toBase58());
  assert.ok(!v.agents.some((a) => a.agent === agentX.toBase58()));
  const a = v.agents.find((x) => x.agent === agentA.toBase58())!;
  assert.equal(a.regime, 'CALM');
  assert.equal(a.limitToday, '100.00');
  assert.equal(a.spent, '30.00');
  assert.equal(a.remaining, '70.00');
});

test('another owner sees only their own agent; a stranger sees none', async () => {
  const other = await listOwnerAgents(fakeChain(oracleData(0, NOW)), programId, otherOwner, NOW);
  assert.deepEqual(other.agents.map((a) => a.agent), [agentX.toBase58()]);
  const none = await listOwnerAgents(fakeChain(oracleData(0, NOW)), programId, Keypair.generate().publicKey, NOW);
  assert.equal(none.agents.length, 0);
  assert.equal(none.events.length, 0);
});

test('activity of all the owner agents, newest first, with approved and refused spends', async () => {
  const v = await listOwnerAgents(fakeChain(oracleData(0, NOW)), programId, owner, NOW);
  assert.deepEqual(v.events.map((e) => e.kind), ['REJECTED', 'BUY']);
  assert.equal(v.events[0].note, 'refused by the guard: LimitExceeded');
  assert.equal(v.events[0].amount, '900.00');
  assert.equal(v.events[1].amount, '5.00');
  assert.equal(v.events[1].agent, agentA.toBase58());
});

test('stale or missing oracle means CRISIS (limit 0), like the guard', async () => {
  const stale = await listOwnerAgents(fakeChain(oracleData(0, NOW - 10_000)), programId, owner, NOW);
  assert.ok(stale.agents.every((a) => a.regime === 'CRISIS' && a.limitToday === '0.00' && a.oracleStale));
  const missing = await listOwnerAgents(fakeChain(null), programId, owner, NOW);
  assert.ok(missing.agents.every((a) => a.regime === 'CRISIS'));
});

test('a failing activity lookup does not hide the agents', async () => {
  const chain = { ...fakeChain(oracleData(1, NOW)), getSignaturesForAddress: async () => { throw new Error('429'); } };
  const v = await listOwnerAgents(chain, programId, owner, NOW);
  assert.equal(v.agents.length, 2);
  assert.equal(v.agents[0].regime, 'TREND');
  assert.equal(v.events.length, 0);
});

test('eventFromTx: pause, resume, register, foreign program', () => {
  const g = programId.toBase58();
  const mk = (data: number[], programIdStr = g, err: unknown = null) => ({ signature: 's', blockTime: 100, err, ixs: [{ programId: programIdStr, data: Uint8Array.from(data) }] });
  assert.equal(eventFromTx(mk([3, 1]), g, 'a')?.kind, 'PAUSED');
  assert.equal(eventFromTx(mk([3, 0]), g, 'a')?.kind, 'RESUMED');
  assert.equal(eventFromTx(mk([2]), g, 'a')?.kind, 'REGISTERED');
  assert.equal(eventFromTx(mk([3, 1], g, { InstructionError: [0, { Custom: 9 }] }), g, 'a'), null);
  assert.equal(eventFromTx(mk([4], 'other'), g, 'a'), null);
});
