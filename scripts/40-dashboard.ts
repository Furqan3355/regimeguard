// Dashboard: http://localhost:3000 (this machine only). Run: npm run dashboard
// Public demo: set PUBLIC_DEMO=1. The owner key is not loaded, pause and crash simulation are refused,
// and the state tells the web page to hide the operator controls.
import fs from 'node:fs';
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { buildState } from '../src/dashboard/state.ts';
import { readEvents } from '../src/agent/log.ts';
import { decodeOracle, decodePolicy, ixSetPaused, oraclePda, policyPda } from '../src/chain/guard.ts';
import { connection, guardProgramId, loadKeypair } from '../src/chain/keys.ts';

const PORT = Number(process.env.PORT ?? 3000);
const DEMO_FLAG = '.demo-crash';
const READ_ONLY = process.env.PUBLIC_DEMO === '1';

const conn = connection();
const programId = guardProgramId();
const ownerKp = READ_ONLY ? null : loadKeypair('.keys/owner.json');
const agentKp = loadKeypair('.keys/agent.json');
const oracleKp = loadKeypair('.keys/oracle.json');
const policyAddr = policyPda(programId, agentKp.publicKey);
const oracleAddr = oraclePda(programId, oracleKp.publicKey);

const server = createDashboardServer({
  html: () => fs.readFileSync('dashboard/index.html', 'utf8'),

  getState: async () => {
    const [pInfo, oInfo] = await conn.getMultipleAccountsInfo([policyAddr, oracleAddr], 'confirmed');
    if (!pInfo || !oInfo) throw new Error('policy or oracle account not found (run npm run agentsetup / guardsetup)');
    const state = buildState({
      nowSec: Math.floor(Date.now() / 1000),
      policy: decodePolicy(pInfo.data),
      oracle: decodeOracle(oInfo.data),
      demoCrash: fs.existsSync(DEMO_FLAG),
      events: readEvents(15),
      addresses: {
        agent: agentKp.publicKey.toBase58(),
        oracle: oracleAddr.toBase58(),
        program: programId.toBase58(),
        policy: policyAddr.toBase58(),
      },
    });
    return { ...state, readOnly: READ_ONLY };
  },

  setPaused: async (paused) => {
    if (!ownerKp) throw new Error('read-only demo');
    return sendAndConfirmTransaction(
      conn,
      new Transaction().add(ixSetPaused(programId, ownerKp.publicKey, agentKp.publicKey, paused)),
      [ownerKp],
      { commitment: 'confirmed' },
    );
  },

  setDemoCrash: async (on) => {
    if (on) fs.writeFileSync(DEMO_FLAG, '');
    else fs.rmSync(DEMO_FLAG, { force: true });
  },

  readOnly: READ_ONLY,
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log('(Ctrl+C to stop)');
});
