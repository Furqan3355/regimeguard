// Set the regime by hand: npm run oracle -- CALM|TREND|VOLATILE|CRISIS
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { REGIME, decodeOracle, ixUpdateOracle, oraclePda, type RegimeName } from '../src/chain/guard.ts';
import { connection, guardProgramId, loadKeypair } from '../src/chain/keys.ts';

const name = (process.argv[2] ?? '').toUpperCase() as RegimeName;
if (!(name in REGIME)) {
  console.error('Usage: npm run oracle -- CALM|TREND|VOLATILE|CRISIS');
  process.exit(1);
}
const conn = connection();
const programId = guardProgramId();
const oracleKp = loadKeypair('.keys/oracle.json');

const sig = await sendAndConfirmTransaction(
  conn,
  new Transaction().add(ixUpdateOracle(programId, oracleKp.publicKey, REGIME[name])),
  [oracleKp],
);
console.log('Regime set:', name, sig);
const info = await conn.getAccountInfo(oraclePda(programId, oracleKp.publicKey), 'confirmed');
if (info) console.log(decodeOracle(info.data));
