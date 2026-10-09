// Keeper: computes the regime from live prices and keeps writing it to the oracle.
//   npm run keeper                 (keeps running, Ctrl+C to stop)
//   npm run keeper -- --once       (run one round, then exit)
// Demo: create an empty file named ".demo-crash" in the project folder and the keeper sees a simulated crash;
// remove it and recovery starts (back to CALM after 3 consecutive calmer readings).
import fs from 'node:fs';
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { REGIME, ixUpdateOracle, oraclePda } from '../src/chain/guard.ts';
import { connection, guardProgramId, loadKeypair } from '../src/chain/keys.ts';
import { fetchCloses, simulate, step, type KeeperState } from '../src/keeper/keeper.ts';

const symbol = (process.env.SYMBOL ?? 'SOLUSDT').toUpperCase();
const intervalMs = Number(process.env.INTERVAL_SECS ?? 60) * 1000;
const heartbeatMs = Number(process.env.HEARTBEAT_SECS ?? 180) * 1000;
const once = process.argv.includes('--once');
const DEMO_FLAG = '.demo-crash';

const conn = connection();
const programId = guardProgramId();
const oracleKp = loadKeypair('.keys/oracle.json');
const oracleAddr = oraclePda(programId, oracleKp.publicKey);

console.log(`Keeper started | symbol=${symbol} | every ${intervalMs / 1000}s | heartbeat ${heartbeatMs / 1000}s`);
console.log(`Oracle account: ${oracleAddr.toBase58()}`);

let state: KeeperState = { hyst: null, lastWriteMs: 0 };

async function tick() {
  const real = await fetchCloses(symbol);
  const demo = fs.existsSync(DEMO_FLAG);
  const closes = simulate(real, demo ? 'crash' : 'none');
  const now = Date.now();
  const r = step(state, closes, now, heartbeatMs);
  state = r.state;

  const f = r.features;
  console.log(
    `[${new Date(now).toISOString()}] ${demo ? '(SIMULATED CRASH) ' : ''}raw=${r.raw} effective=${r.regime} ` +
      `vol=${f.volRatio.toFixed(2)} dd=${(f.drawdown * 100).toFixed(1)}% shock=${f.shockZ.toFixed(1)} -> ` +
      (r.shouldWrite ? `writing to oracle (${r.why})` : 'no write needed'),
  );

  if (r.shouldWrite) {
    const sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(ixUpdateOracle(programId, oracleKp.publicKey, REGIME[r.regime])),
      [oracleKp],
    );
    console.log(`   oracle updated: ${sig.slice(0, 16)}...`);
  }
}

for (;;) {
  try {
    await tick();
  } catch (e) {
    // the keeper never dies on an error; it just tries again next round
    console.error('   error (will retry next round):', (e as Error).message.split('\n')[0]);
    // if the write failed, try writing again next round
    state = { ...state, lastWriteMs: 0 };
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, intervalMs));
}
