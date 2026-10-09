// Helper that derives the Subscriptions program addresses (used by tests, setup and the agent).
import { PublicKey } from '@solana/web3.js';
import { address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import {
  findEventAuthorityPda,
  findFixedDelegationPda,
  findSubscriptionAuthorityPda,
} from '@solana/subscriptions';
import { guardPda, type PullAccounts } from './guard.ts';

export async function derivePullAccounts(opts: {
  programId: PublicKey; // guard program
  owner: PublicKey;
  mint: PublicKey;
  receiverAta: PublicKey;
  nonce: bigint;
}): Promise<PullAccounts> {
  const guardAddr = address(guardPda(opts.programId).toBase58());
  const ownerAddr = address(opts.owner.toBase58());
  const tokenMint = address(opts.mint.toBase58());

  const [subscriptionAuthority] = await findSubscriptionAuthorityPda({ user: ownerAddr, tokenMint });
  const [delegationPda] = await findFixedDelegationPda({
    subscriptionAuthority,
    delegator: ownerAddr,
    delegatee: guardAddr,
    nonce: opts.nonce,
  });
  const [delegatorAta] = await findAssociatedTokenPda({
    owner: ownerAddr,
    mint: tokenMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [eventAuthority] = await findEventAuthorityPda();

  return {
    delegationPda: new PublicKey(delegationPda),
    subscriptionAuthority: new PublicKey(subscriptionAuthority),
    delegatorAta: new PublicKey(delegatorAta),
    receiverAta: opts.receiverAta,
    tokenMint: opts.mint,
    tokenProgram: new PublicKey(TOKEN_PROGRAM_ADDRESS),
    eventAuthority: new PublicKey(eventAuthority),
  };
}
