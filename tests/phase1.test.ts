import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, createClient } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import {
  fetchMaybeFixedDelegation,
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
  subscriptionsProgram,
} from '@solana/subscriptions';

const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const tokenMint = address(process.env.MINT_ADDRESS!);
const receiverAta = address(process.env.RECEIVER_ATA!);

const make = (key: string) =>
  createClient()
    .use(signerFromFile(key))
    .use(solanaDevnetRpc({ rpcUrl }))
    .use(subscriptionsProgram());

const owner = await make('.keys/owner.json');
const agent = await make('.keys/agent.json');
const ownerAddr = owner.identity.address;
const agentAddr = agent.identity.address;

const NONCE = BigInt(Date.now()); // har run ka naya allowance
const LIMIT = 50_000_000n;        // 50 tokens
const SPEND = 10_000_000n;        // 10 tokens

const [subscriptionAuthority] = await findSubscriptionAuthorityPda({ user: ownerAddr, tokenMint });
const [delegationPda] = await findFixedDelegationPda({
  subscriptionAuthority,
  delegator: ownerAddr,
  delegatee: agentAddr,
  nonce: NONCE,
});
const [delegatorAta] = await findAssociatedTokenPda({
  owner: ownerAddr,
  mint: tokenMint,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 20) {
  let last = await fn();
  for (let i = 0; i < tries && !ok(last); i++) {
    await sleep(1000);
    last = await fn();
  }
  return last;
}
const getAcc = () => fetchMaybeFixedDelegation(owner.rpc, delegationPda);
const spend = (amount: bigint) =>
  agent.subscriptions.instructions
    .transferFixed({
      delegatee: agent.identity,
      delegator: ownerAddr,
      delegatorAta,
      tokenMint,
      delegationPda,
      amount,
      receiverAta,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
    .sendTransaction();

test('wallets mein fee ke liye SOL hai', async () => {
  for (const c of [owner, agent]) {
    const { value } = await c.rpc.getBalance(c.identity.address).send();
    assert.ok(Number(value) > 50_000_000, 'kam az kam 0.05 SOL chahiye');
  }
});

test('owner ka Subscription Authority initialized hai', async () => {
  const { initialized } = await owner.subscriptions.queries.isSubscriptionAuthorityInitialized(
    ownerAddr,
    tokenMint,
  );
  assert.equal(initialized, true, 'pehle `npm run init` chalao');
});

test('allowance banta hai: sahi amount aur sahi agent', async () => {
  await owner.subscriptions.instructions
    .createFixedDelegation({
      tokenMint,
      delegatee: agentAddr,
      nonce: NONCE,
      amount: LIMIT,
      expiryTs: BigInt(Math.floor(Date.now() / 1000) + 3600),
    })
    .sendTransaction();
  const acc = await waitFor(getAcc, (a) => a.exists);
  assert.ok(acc.exists);
  assert.equal(acc.data.amount, LIMIT);
  assert.equal(acc.data.header.delegatee, agentAddr);
  assert.equal(acc.data.header.delegator, ownerAddr);
});

test('agent limit ke andar kharch kar sakta hai, baqi amount ghat jata hai', async () => {
  await spend(SPEND);
  const acc = await waitFor(getAcc, (a) => a.exists && a.data.amount === LIMIT - SPEND);
  assert.ok(acc.exists);
  assert.equal(acc.data.amount, LIMIT - SPEND);
});

test('agent baqi amount se zyada kharch kare to chain reject karti hai', async () => {
  await assert.rejects(spend(100_000_000n)); // 100 > 40 bacha hua
  const acc = await getAcc();
  assert.ok(acc.exists);
  assert.equal(acc.data.amount, LIMIT - SPEND, 'reject hone par amount nahi badalna chahiye');
});

test('owner allowance revoke kare to agent ka spend band ho jata hai', async () => {
  await owner.subscriptions.instructions
    .revokeDelegation({ authority: owner.identity, delegationAccount: delegationPda })
    .sendTransaction();
  const acc = await waitFor(getAcc, (a) => !a.exists);
  assert.equal(acc.exists, false);
  await assert.rejects(spend(1_000_000n));
});