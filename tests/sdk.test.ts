import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { policyPda } from '../src/chain/guard.ts';
import { derivePullAccounts } from '../src/chain/subs.ts';
import {
  RegimeGuardAgent,
  buildConnectionConfig,
  parseConnectionConfig,
  parseRegisterArgs,
} from '../src/sdk/index.ts';

const key = () => Keypair.generate().publicKey;
const PROGRAM = key();
const ORACLE = key();
const OWNER = key();
const MINT = key();
const RECEIVER = key();
const NONCE = 1_700_000_000_123n;

function makeConfig(agent: PublicKey) {
  return buildConnectionConfig({
    rpcUrl: 'https://api.devnet.solana.com',
    guardProgram: PROGRAM,
    oracle: ORACLE,
    owner: OWNER,
    agent,
    mint: MINT,
    receiverAta: RECEIVER,
    nonce: NONCE,
  });
}

// ---- register arguments ----

test('register args: defaults and a flag in both styles', () => {
  const agent = key();
  const a = parseRegisterArgs(['--agent', agent.toBase58(), `--receiver=${RECEIVER.toBase58()}`], {});
  assert.equal(a.agent.toBase58(), agent.toBase58());
  assert.equal(a.receiver.toBase58(), RECEIVER.toBase58());
  assert.equal(a.limitTokens, 100);
  assert.equal(a.allowanceTokens, 500);
  assert.equal(a.days, 3);
  assert.equal(a.stalenessSecs, 600);
  assert.equal(a.ownerKeyPath, '.keys/owner.json');
  assert.equal(a.oracle, null);
  assert.equal(a.nonce, null);
  assert.equal(a.out, `agent-config.${agent.toBase58().slice(0, 8)}.json`);
});

test('register args: the receiver can come from RECEIVER_ATA and values can be overridden', () => {
  const a = parseRegisterArgs(
    ['--agent', key().toBase58(), '--limit', '25.5', '--days', '7', '--nonce', '42', '--out', 'x.json'],
    { RECEIVER_ATA: RECEIVER.toBase58() },
  );
  assert.equal(a.receiver.toBase58(), RECEIVER.toBase58());
  assert.equal(a.limitTokens, 25.5);
  assert.equal(a.days, 7);
  assert.equal(a.nonce, 42n);
  assert.equal(a.out, 'x.json');
});

test('register args: clear errors for a missing, unknown or invalid value', () => {
  const ok = ['--agent', key().toBase58(), '--receiver', RECEIVER.toBase58()];
  assert.throws(() => parseRegisterArgs([], {}), /--agent .* is required/);
  assert.throws(() => parseRegisterArgs(['--agent', key().toBase58()], {}), /--receiver/);
  assert.throws(() => parseRegisterArgs([...ok, '--colour', 'red'], {}), /unknown flag --colour/);
  assert.throws(() => parseRegisterArgs([...ok, '--limit'], {}), /--limit needs a value/);
  assert.throws(() => parseRegisterArgs([...ok, '--limit', 'abc'], {}), /not a number/);
  assert.throws(() => parseRegisterArgs([...ok, '--limit', '0'], {}), /at least/);
  assert.throws(() => parseRegisterArgs([...ok, '--days', '0'], {}), /between 1 and 365/);
  assert.throws(() => parseRegisterArgs([...ok, '--days', '1.5'], {}), /whole number/);
  assert.throws(() => parseRegisterArgs(['--agent', 'not-an-address', '--receiver', RECEIVER.toBase58()], {}), /not a valid address/);
  assert.throws(() => parseRegisterArgs([...ok, 'stray'], {}), /unexpected argument/);
});

// ---- connection config ----

test('connection config: build, then parse, gives the same config and the right policy address', () => {
  const agent = key();
  const c = makeConfig(agent);
  assert.equal(c.policy, policyPda(PROGRAM, agent).toBase58());
  assert.equal(c.allowanceNonce, NONCE.toString());
  assert.deepEqual(parseConnectionConfig(JSON.parse(JSON.stringify(c))), c);
});

test('connection config: refuses anything that looks like a secret', () => {
  const c = { ...makeConfig(key()), secretKey: [1, 2, 3] };
  assert.throws(() => parseConnectionConfig(c), /looks like a secret/);
  assert.throws(() => parseConnectionConfig({ ...makeConfig(key()), privateKey: 'x' }), /looks like a secret/);
});

test('connection config: clear errors for damaged files', () => {
  const c = makeConfig(key());
  assert.throws(() => parseConnectionConfig(null), /JSON object/);
  assert.throws(() => parseConnectionConfig({ ...c, version: 2 }), /version/);
  assert.throws(() => parseConnectionConfig({ ...c, network: 'mainnet' }), /devnet/);
  assert.throws(() => parseConnectionConfig({ ...c, rpcUrl: 'ftp://x' }), /rpcUrl/);
  assert.throws(() => parseConnectionConfig({ ...c, owner: 'nope' }), /"owner" is not a valid address/);
  assert.throws(() => parseConnectionConfig({ ...c, allowanceNonce: '12x' }), /allowanceNonce/);
  assert.throws(() => parseConnectionConfig({ ...c, decimals: 99 }), /decimals/);
});

// ---- the agent client (no network needed) ----

test('agent client: refuses a config that belongs to another agent', async () => {
  const config = makeConfig(key());
  await assert.rejects(RegimeGuardAgent.fromConfig(config, Keypair.generate()), /config is for agent/);
});

test('agent client: refuses a config whose policy address does not match', async () => {
  const agentKp = Keypair.generate();
  const config = { ...makeConfig(agentKp.publicKey), policy: key().toBase58() };
  await assert.rejects(RegimeGuardAgent.fromConfig(config, agentKp), /does not match/);
});

test('agent client: builds a correct spend instruction', async () => {
  const agentKp = Keypair.generate();
  const client = await RegimeGuardAgent.fromConfig(makeConfig(agentKp.publicKey), agentKp);
  const ix = client.pullInstruction(2_500_000n);

  assert.equal(ix.programId.toBase58(), PROGRAM.toBase58());
  assert.equal(ix.keys[0].pubkey.toBase58(), agentKp.publicKey.toBase58()); // the agent signs
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[1].pubkey.toBase58(), policyPda(PROGRAM, agentKp.publicKey).toBase58());
  assert.equal(ix.keys[2].pubkey.toBase58(), ORACLE.toBase58());
  assert.equal(ix.data[0], 4); // the Pull instruction
  assert.equal(ix.data.readBigUInt64LE(1), 2_500_000n);

  const expected = await derivePullAccounts({ programId: PROGRAM, owner: OWNER, mint: MINT, receiverAta: RECEIVER, nonce: NONCE });
  assert.equal(ix.keys[5].pubkey.toBase58(), expected.delegationPda.toBase58());
  assert.equal(ix.keys[7].pubkey.toBase58(), expected.delegatorAta.toBase58());
  assert.equal(ix.keys[8].pubkey.toBase58(), RECEIVER.toBase58());
});

test('agent client: refuses a zero amount and converts tokens to units', async () => {
  const agentKp = Keypair.generate();
  const client = await RegimeGuardAgent.fromConfig(makeConfig(agentKp.publicKey), agentKp);
  assert.throws(() => client.pullInstruction(0n), /greater than zero/);
  assert.equal(client.tokensToUnits(1.5), 1_500_000n);
  assert.equal(client.unitsToTokens(2_250_000n), 2.25);
  assert.throws(() => client.tokensToUnits(-1), /zero or more/);
  assert.throws(() => client.tokensToUnits(Number.NaN), /zero or more/);
});

// ---- reading the budget (a fake connection stands in for the chain) ----

const T = (n: number) => BigInt(n) * 1_000_000n;

function policyBytes(o: { agent: PublicKey; base: bigint; spent?: bigint; paused?: boolean; staleness?: bigint }) {
  const b = Buffer.alloc(259);
  b[0] = 1;
  OWNER.toBuffer().copy(b, 1);
  o.agent.toBuffer().copy(b, 33);
  b.writeBigUInt64LE(o.base, 225);
  b.writeBigUInt64LE(o.staleness ?? 600n, 233);
  b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000 / 86_400)), 241); // today
  b.writeBigUInt64LE(o.spent ?? 0n, 249);
  b[257] = o.paused ? 1 : 0;
  return b;
}

function oracleBytes(regime: number, ageSecs: number) {
  const b = Buffer.alloc(43);
  b[0] = 2;
  ORACLE.toBuffer().copy(b, 1);
  b[33] = regime;
  b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) - ageSecs), 34);
  return b;
}

async function stateFor(opts: { base?: bigint; spent?: bigint; paused?: boolean; regime: number; ageSecs: number }) {
  const agentKp = Keypair.generate();
  const policy = policyBytes({ agent: agentKp.publicKey, base: opts.base ?? T(100), spent: opts.spent, paused: opts.paused });
  const fake = { getMultipleAccountsInfo: async () => [{ data: policy }, { data: oracleBytes(opts.regime, opts.ageSecs) }] };
  const client = await RegimeGuardAgent.fromConfig(makeConfig(agentKp.publicKey), agentKp, { connection: fake as never });
  return client.state();
}

test('budget: CALM gives the full limit minus what was spent', async () => {
  const s = await stateFor({ regime: 0, ageSecs: 5, spent: T(30) });
  assert.equal(s.regime, 'CALM');
  assert.equal(s.limit, T(100));
  assert.equal(s.remaining, T(70));
  assert.equal(s.oracleStale, false);
});

test('budget: VOLATILE limits to 30 percent', async () => {
  const s = await stateFor({ regime: 2, ageSecs: 5 });
  assert.equal(s.regime, 'VOLATILE');
  assert.equal(s.limit, T(30));
  assert.equal(s.remaining, T(30));
});

test('budget: CRISIS allows nothing', async () => {
  const s = await stateFor({ regime: 3, ageSecs: 5 });
  assert.equal(s.regime, 'CRISIS');
  assert.equal(s.remaining, 0n);
});

test('budget: a stale oracle counts as CRISIS', async () => {
  const s = await stateFor({ regime: 0, ageSecs: 4000 });
  assert.equal(s.regime, 'CRISIS');
  assert.equal(s.oracleStale, true);
  assert.equal(s.remaining, 0n);
});

test('budget: a paused policy has nothing left to spend', async () => {
  const s = await stateFor({ regime: 0, ageSecs: 5, paused: true });
  assert.equal(s.paused, true);
  assert.equal(s.remaining, 0n);
});

test('budget: clear errors when the policy or the oracle is missing', async () => {
  const agentKp = Keypair.generate();
  const noPolicy = { getMultipleAccountsInfo: async () => [null, { data: oracleBytes(0, 5) }] };
  const a = await RegimeGuardAgent.fromConfig(makeConfig(agentKp.publicKey), agentKp, { connection: noPolicy as never });
  await assert.rejects(a.state(), /No policy found/);

  const policy = policyBytes({ agent: agentKp.publicKey, base: T(100) });
  const noOracle = { getMultipleAccountsInfo: async () => [{ data: policy }, null] };
  const b = await RegimeGuardAgent.fromConfig(makeConfig(agentKp.publicKey), agentKp, { connection: noOracle as never });
  await assert.rejects(b.state(), /Oracle account not found/);
});
