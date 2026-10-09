// Prints the PUBLIC addresses of your three wallets (never the secret keys).
// You need the owner's address as OWNER_PUBKEY when you deploy the public demo.   Run: npm run pubkeys
import { loadKeypair } from '../src/chain/keys.ts';

for (const name of ['owner', 'agent', 'oracle']) {
  console.log(`${name.padEnd(7)} ${loadKeypair(`.keys/${name}.json`).publicKey.toBase58()}`);
}
