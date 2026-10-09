import { address, createClient } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import {
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
  subscriptionsProgram,
} from '@solana/subscriptions';

const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const tokenMint = address(process.env.MINT_ADDRESS!);
const receiverAta = address(process.env.RECEIVER_ATA!);

const ownerClient = await createClient().use(signerFromFile('.keys/owner.json'));
const delegator = ownerClient.identity.address;

const agent = await createClient()
  .use(signerFromFile('.keys/agent.json'))
  .use(solanaDevnetRpc({ rpcUrl }))
  .use(subscriptionsProgram());

const NONCE = 0n;
const [delegatorAta] = await findAssociatedTokenPda({
  owner: delegator,
  mint: tokenMint,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
const [subscriptionAuthority] = await findSubscriptionAuthorityPda({ user: delegator, tokenMint });
const [delegationPda] = await findFixedDelegationPda({
  subscriptionAuthority,
  delegator,
  delegatee: agent.identity.address,
  nonce: NONCE,
});

const SPEND = 10_000_000n; // 10 tokens
console.log('Agent 10 token kharch kar raha hai...');

const result = await agent.subscriptions.instructions
  .transferFixed({
    delegatee: agent.identity,
    delegator,
    delegatorAta,
    tokenMint,
    delegationPda,
    amount: SPEND,
    receiverAta,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  .sendTransaction();

console.log('Spend ho gaya.', result ?? '');