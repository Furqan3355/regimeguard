// Demo agent setup (run once; running it again changes nothing):
// 1) an allowance for the agent (delegatee = guard PDA), 2) the agent's policy.
import fs from 'node:fs';
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { address, createClient } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import { fetchMaybeFixedDelegation, subscriptionsProgram } from '@solana/subscriptions';
import { POLICY_LEN, guardPda, ixInitPolicy, oraclePda, policyPda } from '../src/chain/guard.ts';
import { derivePullAccounts } from '../src/chain/subs.ts';
import { connection, guardProgramId, loadKeypair, rpcUrl } from '../src/chain/keys.ts';

const CONFIG = '.agent-config.json';
const T = (n: number) => BigInt(n) * 1_000_000n;

const conn = connection();
const programId = guardProgramId();
const mint = new PublicKey(process.env.MINT_ADDRESS!);
const receiverAta = new PublicKey(process.env.RECEIVER_ATA!);
const ownerKp = loadKeypair('.keys/owner.json');
const agentKp = loadKeypair('.keys/agent.json');
const oracleKp = loadKeypair('.keys/oracle.json');

// keep the nonce in a file so that running it again finds the same allowance
let nonce: bigint;
if (fs.existsSync(CONFIG)) {
  nonce = BigInt(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).nonce);
} else {
  nonce = BigInt(Date.now());
  fs.writeFileSync(CONFIG, JSON.stringify({ nonce: nonce.toString() }, null, 2));
}

const accounts = await derivePullAccounts({ programId, owner: ownerKp.publicKey, mint, receiverAta, nonce });

// 1) allowance
const ownerClient = await createClient()
  .use(signerFromFile('.keys/owner.json'))
  .use(solanaDevnetRpc({ rpcUrl }))
  .use(subscriptionsProgram());

const existing = await fetchMaybeFixedDelegation(
  ownerClient.rpc,
  address(accounts.delegationPda.toBase58()),
);
if (existing.exists) {
  console.log('Allowance already exists:', accounts.delegationPda.toBase58());
} else {
  await ownerClient.subscriptions.instructions
    .createFixedDelegation({
      tokenMint: address(mint.toBase58()),
      delegatee: address(guardPda(programId).toBase58()),
      nonce,
      amount: T(500),
      expiryTs: BigInt(Math.floor(Date.now() / 1000) + 3 * 24 * 3600),
    })
    .sendTransaction();
  console.log('Allowance created (500 tokens, 3 days):', accounts.delegationPda.toBase58());
}

// 2) policy
const policy = policyPda(programId, agentKp.publicKey);
if (await conn.getAccountInfo(policy, 'confirmed')) {
  console.log('Policy already exists:', policy.toBase58());
} else {
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(POLICY_LEN));
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      ixInitPolicy(programId, ownerKp.publicKey, rent, {
        agent: agentKp.publicKey,
        oracle: oraclePda(programId, oracleKp.publicKey),
        mint,
        delegatorAta: accounts.delegatorAta,
        receiverAta,
        delegation: accounts.delegationPda,
        baseDailyLimit: T(100),
        maxStalenessSecs: 600n,
      }),
    ),
    [ownerKp],
  );
  console.log('Policy created (base daily limit 100 tokens):', policy.toBase58());
}
console.log('Agent wallet:', agentKp.publicKey.toBase58());
console.log('Setup complete. Start the keeper first, then: npm run agent');
