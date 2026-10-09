import { address, createClient } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import {
  fetchMaybeFixedDelegation,
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
} from '@solana/subscriptions';

const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const tokenMint = address(process.env.MINT_ADDRESS!);

const owner = await createClient()
  .use(signerFromFile('.keys/owner.json'))
  .use(solanaDevnetRpc({ rpcUrl }));
const agent = await createClient().use(signerFromFile('.keys/agent.json'));

const [subscriptionAuthority] = await findSubscriptionAuthorityPda({
  user: owner.identity.address,
  tokenMint,
});
const [delegationPda] = await findFixedDelegationPda({
  subscriptionAuthority,
  delegator: owner.identity.address,
  delegatee: agent.identity.address,
  nonce: 0n,
});

const account = await fetchMaybeFixedDelegation(owner.rpc, delegationPda);
console.log('exists:', account.exists);
if (account.exists) {
  console.log(
    JSON.stringify(account.data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
}