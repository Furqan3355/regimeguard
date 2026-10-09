// Run once: fund the oracle wallet with a little SOL and create the oracle account (if it does not exist).
import { SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { ORACLE_LEN, decodeOracle, ixInitOracle, oraclePda } from '../src/chain/guard.ts';
import { connection, guardProgramId, loadKeypair } from '../src/chain/keys.ts';

const conn = connection();
const programId = guardProgramId();
const owner = loadKeypair('.keys/owner.json');
const oracleKp = loadKeypair('.keys/oracle.json');
const oracleAddr = oraclePda(programId, oracleKp.publicKey);

const bal = await conn.getBalance(oracleKp.publicKey);
if (bal < 50_000_000) {
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: oracleKp.publicKey,
        lamports: 100_000_000,
      }),
    ),
    [owner],
  );
  console.log('Gave the oracle wallet 0.1 SOL.');
}

const existing = await conn.getAccountInfo(oracleAddr, 'confirmed');
if (existing) {
  console.log('Oracle account already exists:', oracleAddr.toBase58());
  console.log(decodeOracle(existing.data));
} else {
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(ORACLE_LEN));
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(ixInitOracle(programId, oracleKp.publicKey, rent)),
    [oracleKp],
  );
  console.log('Oracle account created:', oracleAddr.toBase58());
}
