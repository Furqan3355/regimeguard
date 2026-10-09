// A minimal agent that spends through RegimeGuard. Copy the idea into your own agent.
//
//   npm run example -- <connection config file> [agent key file] [--once]
//
// The config file comes from `npm run register` (or, later, from the website). The agent key file is the agent's
// own key (a JSON list of numbers, same format as the Solana CLI). Default key file: .keys/agent.json
import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { GuardRejectionError, RegimeGuardAgent } from '../src/sdk/index.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const once = process.argv.includes('--once');
const [configPath, keyPath = '.keys/agent.json'] = args;
if (!configPath) {
  console.error('Usage: npm run example -- <connection config file> [agent key file] [--once]');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));
const agent = await RegimeGuardAgent.fromConfig(config, key);

const everySecs = Number(process.env.EXAMPLE_INTERVAL_SECS ?? 20);
const wantTokens = Number(process.env.WANT_TOKENS ?? 1);
console.log(`Agent ${key.publicKey.toBase58()} | wants ${wantTokens} token(s) each round`);

async function round() {
  const s = await agent.state(); // 1) ask the chain what is allowed right now
  const left = agent.unitsToTokens(s.remaining).toFixed(2);
  console.log(`regime=${s.regime} paused=${s.paused} left today=${left}`);

  const want = agent.tokensToUnits(wantTokens);
  const amount = want > s.remaining ? s.remaining : want; // 2) never ask for more than what is left
  if (amount === 0n) {
    console.log('  nothing allowed right now, waiting');
    return;
  }
  try {
    const sig = await agent.pull(amount); // 3) the guard checks everything again on-chain
    console.log(`  spent ${agent.unitsToTokens(amount)} token(s): ${sig}`);
  } catch (e) {
    if (e instanceof GuardRejectionError) console.log(`  rejected: ${e.reason}`);
    else throw e;
  }
}

do {
  try {
    await round();
  } catch (e) {
    console.log(`  problem: ${(e as Error).message.split('\n')[0]}`);
  }
  if (!once) await new Promise((r) => setTimeout(r, everySecs * 1000));
} while (!once);
