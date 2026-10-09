// Registers ANY agent address (not just the demo agent). Run it as the OWNER, the person whose money it is:
// 1) creates the owner's allowance for the guard, 2) creates the agent's policy, 3) writes the connection config.
// The agent's secret key is never needed, only its public address.
//
//   npm run register -- --agent <agent address> --receiver <token account> [--limit 100] [--allowance 500] [--days 3]
//
// Flags: --limit (daily limit in calm markets, tokens), --allowance (total tokens the guard may move), --days (allowance length),
//        --staleness (seconds before an old oracle counts as CRISIS), --owner-key (default .keys/owner.json),
//        --oracle (default: from .keys/oracle.json), --out (config file to write), --nonce (advanced)
import fs from 'node:fs';
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { address, createClient } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';
import { fetchMaybeFixedDelegation, subscriptionsProgram } from '@solana/subscriptions';
import { POLICY_LEN, decodePolicy, guardPda, ixInitPolicy, oraclePda, policyPda } from '../src/chain/guard.ts';
import { derivePullAccounts } from '../src/chain/subs.ts';
import { connection, guardProgramId, loadKeypair, rpcUrl } from '../src/chain/keys.ts';
import { DECIMALS, buildConnectionConfig, parseConnectionConfig, parseRegisterArgs } from '../src/sdk/config.ts';

let args;
try {
  args = parseRegisterArgs(process.argv.slice(2), process.env);
} catch (e) {
  console.error(`Problem with the arguments: ${(e as Error).message}`);
  console.error('Example: npm run register -- --agent <agent address> --receiver <token account> --limit 100');
  process.exit(1);
}

const units = (tokens: number) => BigInt(Math.round(tokens * 10 ** DECIMALS));

const conn = connection();
const programId = guardProgramId();
if (!process.env.MINT_ADDRESS) throw new Error('MINT_ADDRESS is missing from .env');
const mint = new PublicKey(process.env.MINT_ADDRESS);
const ownerKp = loadKeypair(args.ownerKeyPath);
const oracleAddr = args.oracle ?? oraclePda(programId, loadKeypair('.keys/oracle.json').publicKey);

if (args.agent.equals(ownerKp.publicKey)) {
  throw new Error('The agent must have its own key, different from the owner wallet. Create a separate key for the agent.');
}
if (!(await conn.getAccountInfo(args.receiver, 'confirmed'))) {
  throw new Error(`The receiver ${args.receiver.toBase58()} does not exist on this network. Create that token account first.`);
}

// Running it again for the same agent finds the same allowance: the nonce is kept in the config file.
let nonce = args.nonce ?? BigInt(Date.now());
if (args.nonce === null && fs.existsSync(args.out)) {
  const old = parseConnectionConfig(JSON.parse(fs.readFileSync(args.out, 'utf8')));
  if (old.agent === args.agent.toBase58()) nonce = BigInt(old.allowanceNonce);
}

const accounts = await derivePullAccounts({
  programId,
  owner: ownerKp.publicKey,
  mint,
  receiverAta: args.receiver,
  nonce,
});

// 1) allowance (delegatee = the guard)
const ownerClient = await createClient()
  .use(signerFromFile(args.ownerKeyPath))
  .use(solanaDevnetRpc({ rpcUrl }))
  .use(subscriptionsProgram());

const existing = await fetchMaybeFixedDelegation(ownerClient.rpc, address(accounts.delegationPda.toBase58()));
if (existing.exists) {
  console.log('Allowance already exists:', accounts.delegationPda.toBase58());
} else {
  await ownerClient.subscriptions.instructions
    .createFixedDelegation({
      tokenMint: address(mint.toBase58()),
      delegatee: address(guardPda(programId).toBase58()),
      nonce,
      amount: units(args.allowanceTokens),
      expiryTs: BigInt(Math.floor(Date.now() / 1000) + args.days * 24 * 3600),
    })
    .sendTransaction();
  console.log(`Allowance created (${args.allowanceTokens} tokens, ${args.days} days):`, accounts.delegationPda.toBase58());
}

// 2) policy (one per agent address)
const policy = policyPda(programId, args.agent);
const policyInfo = await conn.getAccountInfo(policy, 'confirmed');
if (policyInfo) {
  let owner = 'unknown';
  try {
    owner = decodePolicy(policyInfo.data).owner;
  } catch {
    /* not a readable policy */
  }
  if (owner !== ownerKp.publicKey.toBase58()) {
    throw new Error(
      `A policy for this agent address already exists and its owner is ${owner}, not you. ` +
        'A policy cannot be changed or closed, so this agent address cannot be registered under your wallet.',
    );
  }
  console.log('Policy already exists:', policy.toBase58());
} else {
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(POLICY_LEN));
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      ixInitPolicy(programId, ownerKp.publicKey, rent, {
        agent: args.agent,
        oracle: oracleAddr,
        mint,
        delegatorAta: accounts.delegatorAta,
        receiverAta: args.receiver,
        delegation: accounts.delegationPda,
        baseDailyLimit: units(args.limitTokens),
        maxStalenessSecs: BigInt(args.stalenessSecs),
      }),
    ),
    [ownerKp],
  );
  console.log(`Policy created (base daily limit ${args.limitTokens} tokens):`, policy.toBase58());
}

// 3) connection config: safe to share, it contains no secret
const config = buildConnectionConfig({
  rpcUrl,
  guardProgram: programId,
  oracle: oracleAddr,
  owner: ownerKp.publicKey,
  agent: args.agent,
  mint,
  receiverAta: args.receiver,
  nonce,
});
fs.writeFileSync(args.out, JSON.stringify(config, null, 2) + '\n');

console.log('');
console.log(`Connection config written to ${args.out} (no secrets in it).`);
console.log('Give that file to whoever runs the agent. The agent also needs:');
console.log(`  - its own key file, for the address ${args.agent.toBase58()}`);
console.log('  - a little devnet SOL in that address, to pay network fees (https://faucet.solana.com)');
console.log(`  - tokens in the owner's token account (${accounts.delegatorAta.toBase58()}), which is where the money comes from`);
console.log(`Try it:  npm run example -- ${args.out} <path to the agent key file>`);
