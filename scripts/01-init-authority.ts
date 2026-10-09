// One-time setup: registers the owner with the Subscriptions program for the chosen token.
import { address, createClient } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { subscriptionsProgram } from '@solana/subscriptions';

const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const tokenMint = address(process.env.MINT_ADDRESS!);

const owner = await createClient()
  .use(signerFromFile('.keys/owner.json'))
  .use(solanaDevnetRpc({ rpcUrl }))
  .use(subscriptionsProgram());

const user = owner.identity.address;

const { initialized, pda } =
  await owner.subscriptions.queries.isSubscriptionAuthorityInitialized(user, tokenMint);
console.log('Subscription Authority PDA:', pda);

if (initialized) {
  console.log('Already initialized.');
} else {
  const [userAta] = await findAssociatedTokenPda({
    owner: user,
    mint: tokenMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  console.log('Owner token account:', userAta);
  await owner.subscriptions.instructions
    .initSubscriptionAuthority({
      tokenMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      userAta,
    })
    .sendTransaction();
  console.log('Subscription Authority initialized.');
}
