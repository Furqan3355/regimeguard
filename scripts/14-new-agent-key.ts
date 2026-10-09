// Makes a brand-new key for an agent. An "agent" is just a program with its own key; this creates that key.
//   npm run newagent                   -> writes .keys/agent2.json
//   npm run newagent -- .keys/bob.json -> writes the file you name
// The key file is SECRET (it is inside .keys, which git ignores). Only the printed address is public.
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection } from '../src/chain/keys.ts';

const out = process.argv[2] ?? '.keys/agent2.json';
if (fs.existsSync(out)) {
  console.error(`${out} already exists. I never overwrite a key. Pick another name, for example: npm run newagent -- .keys/agent3.json`);
  process.exit(1);
}

const kp = Keypair.generate();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });

console.log(`New agent key saved to ${out}  (secret: never share it, never commit it)`);
console.log(`Agent address (public, safe to share): ${kp.publicKey.toBase58()}`);

// The agent needs a little devnet SOL to pay network fees. The public faucet is often busy, so failure is normal.
try {
  const conn = connection();
  const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL / 2);
  await Promise.race([
    conn.confirmTransaction(sig, 'confirmed'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 30_000)),
  ]);
  console.log('Received 0.5 devnet SOL for network fees.');
} catch {
  console.log('Could not get devnet SOL automatically (the public faucet is often busy).');
  console.log(`Get it by hand: open https://faucet.solana.com , paste the address above, choose devnet, request 1 SOL.`);
}
