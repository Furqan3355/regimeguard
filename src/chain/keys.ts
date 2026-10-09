import fs from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

export const rpcUrl = process.env.RPC_URL ?? 'https://api.devnet.solana.com';

export const connection = () => new Connection(rpcUrl, 'confirmed');

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8'))));
}

export function guardProgramId(): PublicKey {
  const id = process.env.GUARD_PROGRAM_ID;
  if (!id) throw new Error('GUARD_PROGRAM_ID is missing from .env');
  return new PublicKey(id);
}
