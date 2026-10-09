// Autonomous agent: asks to spend in a loop by itself. Decisions come from fixed rules (src/agent/agent.ts).
//   npm run agent                 normal agent (checks its own limit first)
//   npm run agent -- --stubborn   stubborn agent (always asks for the full amount, the chain stops it)
//   npm run agent -- --once       a single round
import fs from 'node:fs';
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { decodeOracle, decodePolicy, ixPull, oraclePda, policyPda } from '../src/chain/guard.ts';
import { derivePullAccounts } from '../src/chain/subs.ts';
import { connection, guardProgramId, loadKeypair } from '../src/chain/keys.ts';
import { budget, currentRegime, decide, explainError, fmtTokens, nextDelaySecs } from '../src/agent/agent.ts';
import { appendEvent } from '../src/agent/log.ts';

const stubborn = process.argv.includes('--stubborn');
const once = process.argv.includes('--once');
const want = BigInt(Math.round(Number(process.env.WANT_TOKENS ?? 5) * 1_000_000));
const minBuy = 1_000_000n;
const baseDelay = Number(process.env.AGENT_INTERVAL_SECS ?? 15);
const maxDelay = Number(process.env.AGENT_MAX_DELAY_SECS ?? 120);

const conn = connection();
const programId = guardProgramId();
const mint = new PublicKey(process.env.MINT_ADDRESS!);
const receiverAta = new PublicKey(process.env.RECEIVER_ATA!);
// The agent only needs the owner's PUBLIC key. On a server set OWNER_PUBKEY so the owner's secret key never leaves your machine.
const ownerPub = process.env.OWNER_PUBKEY ? new PublicKey(process.env.OWNER_PUBKEY) : loadKeypair('.keys/owner.json').publicKey;
const agentKp = loadKeypair('.keys/agent.json');
const oracleKp = loadKeypair('.keys/oracle.json');

if (!fs.existsSync('.agent-config.json')) {
  console.error('.agent-config.json not found. Run first: npm run agentsetup');
  process.exit(1);
}
const nonce = BigInt(JSON.parse(fs.readFileSync('.agent-config.json', 'utf8')).nonce);
const accounts = await derivePullAccounts({ programId, owner: ownerPub, mint, receiverAta, nonce });
const policyAddr = policyPda(programId, agentKp.publicKey);
const oracleAddr = oraclePda(programId, oracleKp.publicKey);

console.log(`Agent started | ${stubborn ? 'STUBBORN' : 'normal'} mode | requests ${fmtTokens(want)} tokens each time`);
console.log(`Agent: ${agentKp.publicKey.toBase58()}`);

let bought = 0n;
let rejected = 0;
let delay = baseDelay;
let lastWaitKey = ''; // so the same WAIT reason is not written to the file over and over

for (;;) {
  const stamp = new Date().toISOString().slice(11, 19);
  let rejectedNow = false;
  try {
    const [pInfo, oInfo] = await conn.getMultipleAccountsInfo([policyAddr, oracleAddr], 'confirmed');
    if (!pInfo || !oInfo) throw new Error('policy or oracle account not found (run npm run agentsetup / guardsetup)');
    const policy = decodePolicy(pInfo.data);
    const oracle = decodeOracle(oInfo.data);
    const nowSec = Math.floor(Date.now() / 1000);
    const regime = currentRegime(oracle, policy, nowSec);
    const b = budget(policy, regime, nowSec);
    const view = `regime=${regime} limit=${fmtTokens(b.limit)} spent=${fmtTokens(b.spent)}`;

    const action = decide({ nowSec, policy, oracle }, want, minBuy, stubborn);
    if (action.kind === 'wait') {
      rejectedNow = true; // the delay grows while waiting too
      console.log(`[${stamp}] [WAIT:${action.status}] ${view} | ${action.note}`);
      if (lastWaitKey !== action.status) {
        appendEvent({ t: Date.now(), kind: 'WAIT', regime, note: `${action.status}: ${action.note}` });
        lastWaitKey = action.status;
      }
    } else {
      try {
        const sig = await sendAndConfirmTransaction(
          conn,
          new Transaction().add(ixPull(programId, agentKp.publicKey, oracleAddr, accounts, action.amount)),
          [agentKp],
          { commitment: 'confirmed' },
        );
        bought += action.amount;
        lastWaitKey = '';
        appendEvent({ t: Date.now(), kind: 'BUY', amount: fmtTokens(action.amount), regime, note: action.note, sig });
        console.log(`[${stamp}] [BUY] ${fmtTokens(action.amount)} tokens | ${view} | total bought=${fmtTokens(bought)}`);
      } catch (e) {
        rejected++;
        rejectedNow = true;
        lastWaitKey = '';
        appendEvent({
          t: Date.now(),
          kind: 'REJECTED',
          amount: fmtTokens(action.amount),
          regime,
          note: `blocked by chain: ${explainError((e as Error).message)}`,
        });
        console.log(
          `[${stamp}] [REJECTED BY CHAIN] ${fmtTokens(action.amount)} tokens | ${view} | reason: ${explainError(
            (e as Error).message,
          )} | total rejected=${rejected}`,
        );
      }
    }
  } catch (e) {
    rejectedNow = true;
    console.log(`[${stamp}] [ERROR] ${(e as Error).message.split('\n')[0]}`);
    appendEvent({ t: Date.now(), kind: 'ERROR', note: (e as Error).message.split('\n')[0] });
  }
  if (once) break;
  delay = nextDelaySecs(delay, rejectedNow, baseDelay, maxDelay);
  await new Promise((r) => setTimeout(r, delay * 1000));
}
