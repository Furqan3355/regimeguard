// Test helpers: a new agent, a new allowance and a new policy for every test.
// (This is not a test, only a helper. The real tests are in tests/guard.test.ts.)
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { address, createClient } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import { subscriptionsProgram } from '@solana/subscriptions';
import {
  POLICY_LEN,
  REGIME,
  decodePolicy,
  guardPda,
  ixInitPolicy,
  ixPull,
  ixUpdateOracle,
  oraclePda,
  policyPda,
  type PullAccounts,
  type RegimeName,
} from '../../src/chain/guard.ts';
import { derivePullAccounts } from '../../src/chain/subs.ts';
import { connection, guardProgramId, loadKeypair, rpcUrl } from '../../src/chain/keys.ts';

/** n tokens (6 decimals) */
export const T = (n: number): bigint => BigInt(n) * 1_000_000n;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const conn: Connection = connection();
const programId = guardProgramId();
const mint = new PublicKey(process.env.MINT_ADDRESS!);
const receiverAta = new PublicKey(process.env.RECEIVER_ATA!);
const ownerKp = loadKeypair('.keys/owner.json');
const oracleKp = loadKeypair('.keys/oracle.json');
const oracleAddr = oraclePda(programId, oracleKp.publicKey);

const ownerClient = await createClient()
  .use(signerFromFile('.keys/owner.json'))
  .use(solanaDevnetRpc({ rpcUrl }))
  .use(subscriptionsProgram());

const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, {
    commitment: 'confirmed',
  });

export async function setRegime(name: RegimeName) {
  await send([ixUpdateOracle(programId, oracleKp.publicKey, REGIME[name])], [oracleKp]);
}

export interface Fixture {
  agent: Keypair;
  policy: PublicKey;
  pullAccounts: PullAccounts;
}

export async function newFixture(opts: {
  base: bigint;
  maxStaleness?: bigint;
  allowance?: bigint;
}): Promise<Fixture> {
  const agent = Keypair.generate();

  // a little SOL so the agent can pay fees
  await send(
    [
      SystemProgram.transfer({
        fromPubkey: ownerKp.publicKey,
        toPubkey: agent.publicKey,
        lamports: 20_000_000,
      }),
    ],
    [ownerKp],
  );

  // allowance: the delegatee is the guard PDA (not the agent)
  const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const guardAddr = address(guardPda(programId).toBase58());
  const ownerAddr = address(ownerKp.publicKey.toBase58());
  const tokenMint = address(mint.toBase58());
  await ownerClient.subscriptions.instructions
    .createFixedDelegation({
      tokenMint,
      delegatee: guardAddr,
      nonce,
      amount: opts.allowance ?? T(100),
      expiryTs: BigInt(Math.floor(Date.now() / 1000) + 3600),
    })
    .sendTransaction();

  const pullAccounts: PullAccounts = await derivePullAccounts({
    programId,
    owner: ownerKp.publicKey,
    mint,
    receiverAta,
    nonce,
  });

  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(POLICY_LEN));
  await send(
    [
      ixInitPolicy(programId, ownerKp.publicKey, rent, {
        agent: agent.publicKey,
        oracle: oracleAddr,
        mint,
        delegatorAta: pullAccounts.delegatorAta,
        receiverAta,
        delegation: pullAccounts.delegationPda,
        baseDailyLimit: opts.base,
        maxStalenessSecs: opts.maxStaleness ?? 600n,
      }),
    ],
    [ownerKp],
  );

  return { agent, policy: policyPda(programId, agent.publicKey), pullAccounts };
}

/** The agent tries to spend an amount through the guard. Throws on failure. */
export async function pull(fx: Fixture, amount: bigint, signer: Keypair = fx.agent, policy?: PublicKey) {
  return send(
    [ixPull(programId, signer.publicKey, oracleAddr, fx.pullAccounts, amount, policy)],
    [signer],
  );
}

export async function setPaused(fx: Fixture, paused: boolean) {
  const { ixSetPaused } = await import('../../src/chain/guard.ts');
  await send([ixSetPaused(programId, ownerKp.publicKey, fx.agent.publicKey, paused)], [ownerKp]);
}

export async function readPolicy(fx: Fixture) {
  const info = await conn.getAccountInfo(fx.policy, 'confirmed');
  if (!info) throw new Error('policy not found');
  return decodePolicy(info.data);
}

export { ownerClient, ownerKp, conn, programId };
