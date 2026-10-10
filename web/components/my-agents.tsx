'use client'

// "My agents": connect a wallet (or paste an address) and see every agent that wallet registered,
// with each agent's budget and its on-chain activity. Reading is public chain data, so no signature is needed.
import { useCallback, useEffect, useState } from 'react'
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const field: React.CSSProperties = { background: '#0b100e', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 5, padding: '10px 12px', fontFamily: 'monospace', fontSize: 11, width: '100%' }
const code: React.CSSProperties = { background: '#0b100e', border: '1px solid var(--line)', borderRadius: 6, padding: 12, fontFamily: 'monospace', fontSize: 11, color: '#aebcb2', overflowX: 'auto', whiteSpace: 'pre', margin: '8px 0' }

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className="button button-ghost button-small" onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

/** Builds the exact register command. The owner signs it on their own machine; no key ever reaches this website. */
function DeveloperPanel({ owner }: { owner: string }) {
  const [agent, setAgent] = useState('')
  const [limit, setLimit] = useState('100')
  const [allowance, setAllowance] = useState('500')
  const [days, setDays] = useState('3')
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])
  const num = (v: string) => (Number.isFinite(Number(v)) && Number(v) > 0 ? v : '…')
  const agentOk = ADDR.test(agent.trim())
  const cmd = `npm run register -- --agent ${agentOk ? agent.trim() : '<AGENT_ADDRESS>'} --limit ${num(limit)} --allowance ${num(allowance)} --days ${num(days)}`
  const base = origin || 'https://YOUR-SITE'
  const sample = owner || '<OWNER_WALLET>'

  return (
    <div className="dashboard" style={{ marginTop: 12 }}>
      <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
        <div className="panel">
          <div className="section-title"><span>Connect your own agent</span></div>
          <p className="panel-description" style={{ marginTop: 12 }}>
            You do not create an agent here. Bring the agent you already run: it keeps its own key on its own machine, and only its public address is registered. The owner (whose money it is) registers that address with a policy: a daily <b>limit</b> in calm markets and a total <b>allowance</b>. The limit shrinks in risky regimes and drops to 0 in a crisis. The owner signs on their own machine, so no key ever reaches this website.</p>
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            <input style={field} value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="Agent address (public key)" aria-label="Agent address" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
              <input style={field} value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Daily limit in tokens" title="Daily limit (tokens)" />
              <input style={field} value={allowance} onChange={(e) => setAllowance(e.target.value)} aria-label="Total allowance in tokens" title="Total allowance (tokens)" />
              <input style={field} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Allowance length in days" title="Allowance length (days)" />
            </div>
            <div className="base-limit">daily limit · total allowance · days</div>
          </div>
          <div style={code}>{cmd}</div>
          <Copy text={cmd} />
          <div className="base-limit" style={{ marginTop: 14, lineHeight: 1.7 }}>
            1. paste your agent&apos;s public address above (no secret key)<br />
            2. the owner runs the command as the owner (it needs <code>.keys/owner.json</code> and the receiver in <code>.env</code>, or add <code>--receiver</code>). It writes a config file with no secrets<br />
            3. give that config file to your agent and use the SDK (see the API panel)<br />
            4. it appears under Your agents when the owner wallet is connected<br /><br />
            <b>Who needs SOL?</b> Only for network fees: the <b>agent address</b> needs a little devnet SOL (it pays for each spend), and the <b>owner</b> needs a little for the one-time registration. Connecting a wallet here only to look needs no SOL and sends no transaction. The money the agent spends is the owner&apos;s tokens, not SOL.
          </div>
        </div>

        <div className="panel">
          <div className="section-title"><span>Developer API</span></div>
          <p className="panel-description" style={{ marginTop: 12 }}>
            Read-only and public, because it only returns data that is already public on the chain. No API key is needed. Spending and pausing are never possible through this API.
          </p>
          <div style={code}>{`GET ${base}/api/agents?owner=${sample}`}</div>
          <Copy text={`curl "${base}/api/agents?owner=${sample}"`} />
          <div className="base-limit" style={{ marginTop: 10, lineHeight: 1.7 }}>
            Returns every agent of that owner (regime, limit now, spent, remaining, paused) and their recent on-chain activity.
          </div>
          <div style={code}>{`GET ${base}/api/state`}</div>
          <div className="base-limit" style={{ lineHeight: 1.7 }}>The demo agent&apos;s live state and log.</div>
          <div style={code}>{`const agent = await RegimeGuardAgent.fromConfig(config, key)
const s = await agent.state()   // what is allowed now
await agent.pull(amount)        // the chain checks it again`}</div>
          <div className="base-limit">The SDK is in <code>src/sdk</code>; the full guide is <code>docs/BRING-YOUR-OWN-AGENT.md</code>.</div>
        </div>
      </div>
    </div>
  )
}

type Ev = { t: number; kind: string; amount?: string; note: string; sig: string; agent: string }
type Agent = {
  agent: string
  policy: string
  regime: string
  multiplierPct: number
  limitToday: string
  baseLimit: string
  spent: string
  remaining: string
  usedPct: number
  paused: boolean
  oracleStale: boolean
}
type View = { owner: string; guardProgram: string; agents: Agent[]; events: Ev[] }

type Phantom = {
  connect: () => Promise<{ publicKey: { toString(): string } }>
  disconnect?: () => Promise<void>
  signAndSendTransaction?: (tx: Transaction) => Promise<{ signature: string }>
}
const getProvider = (): Phantom | null => {
  const w = window as unknown as { phantom?: { solana?: Phantom }; solana?: Phantom }
  return w.phantom?.solana ?? w.solana ?? null
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function MyAgents() {
  const [owner, setOwner] = useState('')
  const [manual, setManual] = useState('')
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [viaWallet, setViaWallet] = useState(false) // true only when the owner connected a real wallet (can sign)
  const [pending, setPending] = useState('') // agent whose pause/resume is being signed
  const [notice, setNotice] = useState('')

  const load = useCallback(async (o: string) => {
    setBusy(true)
    try {
      const r = await fetch(`/api/agents?owner=${encodeURIComponent(o)}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(r.status === 400 ? 'That is not a valid wallet address.' : 'The server could not read the chain right now.')
      setView((await r.json()) as View)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load agents.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!owner) return
    void load(owner)
    const id = setInterval(() => void load(owner), 10_000)
    return () => clearInterval(id)
  }, [owner, load])

  const connect = async () => {
    const p = getProvider()
    if (!p) return setError('No Solana wallet found. Install Phantom, or paste an address below.')
    try {
      const { publicKey } = await p.connect()
      setView(null)
      setViaWallet(true)
      setOwner(publicKey.toString())
    } catch {
      setError('Wallet connection was cancelled.')
    }
  }
  const disconnect = () => {
    void getProvider()?.disconnect?.().catch(() => {})
    setOwner('')
    setView(null)
    setViaWallet(false)
    setNotice('')
    setError('')
  }
  const useAddress = (a: string) => {
    if (!ADDRESS.test(a.trim())) return setError('That is not a valid wallet address.')
    setView(null)
    setError('')
    setViaWallet(false)
    setOwner(a.trim())
  }
  // Pause/resume: the owner signs one transaction in their own wallet. The chain only accepts it from the policy's owner.
  const togglePause = async (a: Agent) => {
    const p = getProvider()
    if (!p?.signAndSendTransaction || !view?.guardProgram) return setError('Your wallet cannot sign here.')
    setPending(a.agent)
    setError('')
    setNotice('')
    try {
      const bh = (await (await fetch('/api/blockhash', { cache: 'no-store' })).json()) as { blockhash: string }
      const ownerKey = new PublicKey(owner)
      const tx = new Transaction({ feePayer: ownerKey, recentBlockhash: bh.blockhash }).add(
        new TransactionInstruction({
          programId: new PublicKey(view.guardProgram),
          keys: [
            { pubkey: ownerKey, isSigner: true, isWritable: false },
            { pubkey: new PublicKey(a.policy), isSigner: false, isWritable: true },
          ],
          data: Uint8Array.from([3, a.paused ? 0 : 1]) as unknown as Buffer, // SetPaused, 1 = pause, 0 = resume (no global Buffer in the browser)
        }),
      )
      const { signature } = await p.signAndSendTransaction(tx)
      setNotice(`${a.paused ? 'Resume' : 'Pause'} sent (${short(signature)}). The list updates in a few seconds.`)
      setTimeout(() => void load(owner), 5_000)
      setTimeout(() => void load(owner), 18_000) // the server keeps a short cache
    } catch (e) {
      const m = e instanceof Error ? e.message : ''
      setError(/reject|denied|cancel/i.test(m) ? 'You cancelled the transaction.' : 'The transaction could not be sent. Check that Phantom is on Devnet and the owner wallet has a little devnet SOL.')
    } finally {
      setPending('')
    }
  }
  const useDemoOwner = async () => {
    try {
      const s = (await (await fetch('/api/state', { cache: 'no-store' })).json()) as { owner?: string }
      if (s.owner) return useAddress(s.owner)
    } catch {
      /* fall through */
    }
    setError('The demo owner is not available right now.')
  }

  return (
    <section className="dashboard-section" id="my-agents">
      <div className="dashboard-heading">
        <div>
          <div className="eyebrow">YOUR AGENTS</div>
          <h2>
            Connect a wallet.
            <br />
            <em>See only your agents.</em>
          </h2>
        </div>
        <div className="dashboard-status">
          {owner ? (
            <>
              <span className="status-pill green">{short(owner)}</span>
              <button className="button button-ghost button-small" onClick={disconnect}>Disconnect</button>
            </>
          ) : (
            <button className="button button-small" onClick={connect}>Connect wallet</button>
          )}
        </div>
      </div>

      <div className="dashboard">
        {!owner && (
          <div className="panel" style={{ padding: 20 }}>
            <p className="panel-description">
              Every agent is registered on-chain with its owner wallet. Connect the wallet that registered your agents, or paste any wallet address to look at its agents (this data is public on the chain).
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="Owner wallet address"
                aria-label="Owner wallet address"
                style={{ flex: '1 1 280px', background: '#0b100e', border: '1px solid var(--line)', color: 'var(--text)', borderRadius: 5, padding: '10px 12px', fontFamily: 'monospace', fontSize: 11 }}
              />
              <button className="button button-ghost button-small" onClick={() => useAddress(manual)}>View agents</button>
              <button className="button button-ghost button-small" onClick={useDemoOwner}>View demo owner</button>
            </div>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="empty-state" style={{ padding: 12 }}>{notice}</div>}
        {viaWallet && <div className="base-limit" style={{ margin: '10px 2px' }}>Pause and resume are signed in your wallet. Set Phantom to Devnet (Settings, Developer Settings, Testnet Mode).</div>}
        {owner && !view && !error && <div className="empty-state">Reading the chain…</div>}

        {view && view.agents.length === 0 && (
          <div className="empty-state">
            No agents are registered for this wallet yet. Register one with <code>npm run register -- --agent &lt;address&gt; --limit 100</code>, or try the demo owner.
            <div style={{ marginTop: 12 }}>
              <button className="button button-ghost button-small" onClick={useDemoOwner}>View demo owner</button>
            </div>
          </div>
        )}

        {view && view.agents.length > 0 && (
          <>
            <div className="metric-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
              {view.agents.map((a) => (
                <div className="panel" key={a.agent}>
                  <div className="section-title">
                    <span style={{ fontFamily: 'monospace' }}>{short(a.agent)}</span>
                    <span className={`status-pill ${a.paused || a.regime === 'CRISIS' ? 'red' : 'green'}`}>{a.paused ? 'PAUSED' : a.regime}</span>
                  </div>
                  <div className="budget-numbers">
                    <div>
                      <div className="number-main">{a.remaining}</div>
                      <div className="number-label">remaining today</div>
                    </div>
                    <div className="budget-limit">
                      <strong>{a.limitToday}</strong>
                      <span>limit now</span>
                    </div>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${Math.min(100, a.usedPct)}%` }} />
                  </div>
                  <div className="budget-footer">
                    <span>
                      spent <b>{a.spent}</b>
                    </span>
                    <span>
                      base limit <b>{a.baseLimit}</b> · {a.multiplierPct}%
                    </span>
                  </div>
                  {viaWallet && (
                    <div style={{ marginTop: 14 }}>
                      <button className="button button-ghost button-small" disabled={pending === a.agent} onClick={() => void togglePause(a)}>
                        {pending === a.agent ? 'Waiting for wallet…' : a.paused ? 'Resume agent' : 'Pause agent'}
                      </button>
                    </div>
                  )}
                  {a.oracleStale && <div className="base-limit" style={{ color: 'var(--orange)' }}>Regime data is stale, so the guard treats it as CRISIS.</div>}
                </div>
              ))}
            </div>

            <div className="panel activity-panel">
              <div className="section-title">
                <span className="section-label">ACTIVITY OF ALL YOUR AGENTS {busy ? '…' : ''}</span>
                <span className="live-label">
                  <span className="pulse" />
                  FROM THE CHAIN
                </span>
              </div>
              <div className="table-wrap">
                {view.events.length === 0 ? (
                  <div className="empty-state">No transactions yet.</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>TIME</th>
                        <th>AGENT</th>
                        <th>EVENT</th>
                        <th>AMOUNT</th>
                        <th>NOTE</th>
                        <th>TX</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.events.map((e) => (
                        <tr key={e.sig}>
                          <td className="time-cell">{e.t ? new Date(e.t).toLocaleTimeString() : '—'}</td>
                          <td style={{ fontFamily: 'monospace' }}>{short(e.agent)}</td>
                          <td>
                            <span className={`event-badge ${e.kind === 'BUY' ? 'buy' : e.kind === 'REJECTED' ? 'rejected' : 'wait'}`}>{e.kind}</span>
                          </td>
                          <td>{e.amount ?? '—'}</td>
                          <td>{e.note}</td>
                          <td>
                            <a className="tx-link" href={`https://explorer.solana.com/tx/${e.sig}?cluster=devnet`} target="_blank" rel="noreferrer">
                              {short(e.sig)}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <DeveloperPanel owner={owner} />
    </section>
  )
}
