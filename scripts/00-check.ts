import { createClient } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { signerFromFile } from '@solana/kit-plugin-signer';

const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';

for (const name of ['owner', 'agent', 'oracle']) {
  const client = await createClient()
    .use(signerFromFile(`.keys/${name}.json`))
    .use(solanaDevnetRpc({ rpcUrl }));
  const address = client.identity.address;
  const { value } = await client.rpc.getBalance(address).send();
  console.log(`${name.padEnd(7)} ${address}  ${Number(value) / 1e9} SOL`);
}