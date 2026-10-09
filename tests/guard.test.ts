import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, createClient, createKeyPairSignerFromBytes } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { subscriptionsProgram } from '@solana/subscriptions';
import { rpcUrl } from '../src/chain/keys.ts';
import {
  T,
  newFixture,
  ownerKp,
  pull,
  readPolicy,
  setPaused,
  setRegime,
  sleep,
} from './support/fixture.ts';

// error codes of the Rust program (GuardError in program/src/lib.rs)
const E = { NotAgent: 1, Paused: 2, LimitExceeded: 5 } as const;

const rejectedWith = (code: number) => (err: unknown) => {
  const msg = String((err as Error)?.message ?? err);
  assert.ok(
    msg.includes(`custom program error: 0x${code.toString(16)}`) || msg.includes(`"Custom":${code}`),
    `error code ${code} not found: ${msg.slice(0, 300)}`,
  );
  return true;
};

const LONG = { timeout: 180_000 };

test('CALM: the agent can spend within the daily limit', LONG, async () => {
  await setRegime('CALM');
  const fx = await newFixture({ base: T(50) });
  await pull(fx, T(20));
  assert.equal((await readPolicy(fx)).spent, T(20));
});

test('CALM: spending over the daily limit is rejected', LONG, async () => {
  await setRegime('CALM');
  const fx = await newFixture({ base: T(50) });
  await pull(fx, T(30));
  await assert.rejects(pull(fx, T(30)), rejectedWith(E.LimitExceeded));
  assert.equal((await readPolicy(fx)).spent, T(30), 'spending must not increase after a rejection');
});

test('VOLATILE: the limit drops to 30%', LONG, async () => {
  await setRegime('VOLATILE');
  const fx = await newFixture({ base: T(100) });
  await assert.rejects(pull(fx, T(40)), rejectedWith(E.LimitExceeded)); // 40 > 30
  await pull(fx, T(25)); // 25 <= 30
  assert.equal((await readPolicy(fx)).spent, T(25));
});

test('CRISIS: all spending is blocked', LONG, async () => {
  await setRegime('CRISIS');
  const fx = await newFixture({ base: T(100) });
  await assert.rejects(pull(fx, 1n), rejectedWith(E.LimitExceeded));
});

test('after CRISIS, once the regime is CALM again the agent can spend', LONG, async () => {
  const fx = await newFixture({ base: T(100) });
  await setRegime('CRISIS');
  await assert.rejects(pull(fx, T(5)), rejectedWith(E.LimitExceeded));
  await setRegime('CALM');
  await pull(fx, T(5));
  assert.equal((await readPolicy(fx)).spent, T(5));
});

test('a stale oracle is treated like CRISIS', LONG, async () => {
  const fx = await newFixture({ base: T(100), maxStaleness: 6n });
  await setRegime('CALM');
  await pull(fx, T(1)); // fresh, so it works
  await sleep(10_000); // the oracle is now older than 6 seconds
  await assert.rejects(pull(fx, T(1)), rejectedWith(E.LimitExceeded));
  await setRegime('CALM'); // refresh the oracle
  await pull(fx, T(1));
});

test('an agent cannot use the policy of another agent', LONG, async () => {
  await setRegime('CALM');
  const a = await newFixture({ base: T(100) });
  const b = await newFixture({ base: T(100) });
  // agent B using agent A's policy
  await assert.rejects(pull(a, T(1), b.agent, a.policy), rejectedWith(E.NotAgent));
});

test('owner pauses: the agent stops, and works again after unpausing', LONG, async () => {
  await setRegime('CALM');
  const fx = await newFixture({ base: T(100) });
  await setPaused(fx, true);
  await assert.rejects(pull(fx, T(1)), rejectedWith(E.Paused));
  await setPaused(fx, false);
  await pull(fx, T(1));
});

test('the agent cannot pull from the allowance directly, without the guard', LONG, async () => {
  await setRegime('CALM');
  const fx = await newFixture({ base: T(100) });
  const agentSigner = await createKeyPairSignerFromBytes(fx.agent.secretKey);
  const client = await createClient()
    .use(signer(agentSigner))
    .use(solanaDevnetRpc({ rpcUrl }))
    .use(subscriptionsProgram());
  await assert.rejects(
    client.subscriptions.instructions
      .transferFixed({
        delegatee: agentSigner,
        delegator: address(ownerKp.publicKey.toBase58()),
        delegatorAta: address(fx.pullAccounts.delegatorAta.toBase58()),
        tokenMint: address(fx.pullAccounts.tokenMint.toBase58()),
        delegationPda: address(fx.pullAccounts.delegationPda.toBase58()),
        amount: T(1),
        receiverAta: address(fx.pullAccounts.receiverAta.toBase58()),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      .sendTransaction(),
  );
});
