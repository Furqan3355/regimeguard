// Small web server for the dashboard. For this machine only (localhost).
// The real work (reading and writing the blockchain) comes in through `deps`, so the server can be tested.
import http from 'node:http';
import type { DashboardState } from './state.ts';

export interface Deps {
  html: () => string;
  getState: () => Promise<DashboardState>;
  setPaused: (paused: boolean) => Promise<string>; // returns the transaction signature
  setDemoCrash: (on: boolean) => Promise<void>;
  readOnly?: boolean; // public demo: every POST is refused, only GET works
}

const send = (res: http.ServerResponse, status: number, body: string, type = 'application/json') => {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
};

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

export function createDashboardServer(deps: Deps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      // Protects against DNS rebinding: only accept requests addressed to localhost
      const port = req.socket.localPort;
      const host = req.headers.host ?? '';
      if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) {
        return send(res, 403, JSON.stringify({ error: 'host not allowed' }));
      }

      const url = (req.url ?? '/').split('?')[0];

      if (req.method === 'GET' && url === '/') return send(res, 200, deps.html(), 'text/html');

      if (req.method === 'GET' && url === '/api/state') {
        return send(res, 200, JSON.stringify(await deps.getState()));
      }

      if (req.method === 'POST' && (url === '/api/pause' || url === '/api/demo-crash')) {
        // Public demo: nobody can pause the agent or start the crash simulation
        if (deps.readOnly) return send(res, 403, JSON.stringify({ error: 'read-only demo' }));
        // Protects against CSRF: another website cannot add this header
        if (req.headers['x-regimeguard'] !== '1') {
          return send(res, 403, JSON.stringify({ error: 'header required' }));
        }
        const body = await readJson(req);
        if (url === '/api/pause') {
          if (typeof body.paused !== 'boolean') return send(res, 400, JSON.stringify({ error: 'paused must be a boolean' }));
          const sig = await deps.setPaused(body.paused);
          return send(res, 200, JSON.stringify({ ok: true, sig }));
        }
        if (typeof body.on !== 'boolean') return send(res, 400, JSON.stringify({ error: 'on must be a boolean' }));
        await deps.setDemoCrash(body.on);
        return send(res, 200, JSON.stringify({ ok: true }));
      }

      return send(res, 404, JSON.stringify({ error: 'not found' }));
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: (e as Error).message.split('\n')[0] }));
    }
  });
}
