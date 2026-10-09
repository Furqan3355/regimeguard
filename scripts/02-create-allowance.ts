import { address, createClient } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import {
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
  subscriptionsProgram,
} from '@solana/subscriptions';

const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const tokenMint = address(process.env.MINT_ADDRESS!);

const agent = await createClient().use(signerFromFile('.keys/agent.json'));
const delegatee = agent.identity.address;

const owner = await createClient()
  .use(signerFromFile('.keys/owner.json'))
  .use(solanaDevnetRpc({ rpcUrl }))
  .use(subscriptionsProgram());

const NONCE = 0n; // naya allowance banana ho to 1n, 2n... karo
const AMOUNT = 100_000_000n; // 100 tokens (6 decimals)
const expiryTs = BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24); // 24 ghante

console.log('Allowance bana raha hoon: owner ->', delegatee, '100 tokens, 24h');

await owner.subscriptions.instructions
  .createFixedDelegation({
    tokenMint,
    delegatee,
    nonce: NONCE,
    amount: AMOUNT,
    expiryTs,
  })
  .sendTransaction();

const [subscriptionAuthority] = await findSubscriptionAuthorityPda({
  user: owner.identity.address,
  tokenMint,
});
const [delegationPda] = await findFixedDelegationPda({
  subscriptionAuthority,
  delegator: owner.identity.address,
  delegatee,
  nonce: NONCE,
});

console.log('Allowance ban gaya.');
console.log('Delegation PDA:', delegationPda);
console.log('Explorer: https://explorer.solana.com/address/' + delegationPda + '?cluster=devnet');