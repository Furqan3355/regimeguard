// Writes the agent's activity to a file (the dashboard reads it).
import fs from 'node:fs';

export const LOG_FILE = '.agent-log.jsonl';

export interface AgentEvent {
  t: number; // ms
  kind: 'BUY' | 'REJECTED' | 'WAIT' | 'ERROR';
  amount?: string; // tokens, e.g. "5.00"
  regime?: string;
  note: string;
  sig?: string;
}

export function appendEvent(e: AgentEvent, file: string = LOG_FILE): void {
  fs.appendFileSync(file, JSON.stringify(e) + '\n');
}

/** Newest events first. Skips corrupt lines. */
export function readEvents(limit: number, file: string = LOG_FILE): AgentEvent[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit);
  const out: AgentEvent[] = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as AgentEvent;
      if (typeof e.t === 'number' && typeof e.kind === 'string') out.push(e);
    } catch {
      /* corrupt line */
    }
  }
  return out.reverse();
}
