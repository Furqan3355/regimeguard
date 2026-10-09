import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createDashboardServer, type Deps } from '../src/dashboard/server.ts';
import type { DashboardState } from '../src/dashboard/state.ts';

const calls: string[] = [];
const fakeState = { regime: 'CALM' } as unknown as DashboardState;
const deps: Deps = {
  html: () => '<h1>hi</h1>',
  getState: async () => fakeState,
  setPaused: async (p) => {
    calls.push(`pause:${p}`);
    return 'SIG123';
  },
  setDemoCrash: async (on) => {
    calls.push(`crash:${on}`);
  },
};

const server = createDashboardServer(deps);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-regimeguard': '1' }) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('GET / serves the page', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /hi/);
});

test('GET /api/state returns the state', async () => {
  const r = await fetch(base + '/api/state');
  assert.deepEqual(await r.json(), fakeState);
});

test('wrong Host header (rebinding) is rejected', async () => {
  const r = await fetch(base + '/api/state', { headers: { host: 'evil.example.com' } }).catch(() => null);
  // fetch never lets us change the Host header, so check with raw http
  void r;
  const http = await import('node:http');
  const status = await new Promise<number>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example.com' } }, (res) => resolve(res.statusCode ?? 0));
    req.end();
  });
  assert.equal(status, 403);
});

test('POST without the x-regimeguard header is rejected', async () => {
  const r = await post('/api/pause', { paused: true }, {});
  assert.equal(r.status, 403);
  assert.ok(!calls.includes('pause:true'));
});

test('POST pause works with the right header', async () => {
  const r = await post('/api/pause', { paused: true });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, sig: 'SIG123' });
  assert.ok(calls.includes('pause:true'));
});

test('POST pause with the wrong type returns 400', async () => {
  assert.equal((await post('/api/pause', { paused: 'yes' })).status, 400);
});

test('POST demo-crash works', async () => {
  assert.equal((await post('/api/demo-crash', { on: true })).status, 200);
  assert.ok(calls.includes('crash:true'));
});

test('oversized body is rejected', async () => {
  const r = await post('/api/pause', { paused: true, junk: 'x'.repeat(5000) });
  assert.equal(r.status, 500);
});

test('unknown route returns 404', async () => {
  assert.equal((await fetch(base + '/missing')).status, 404);
});

test('read-only demo: pause and crash are refused even with the right header', async () => {
  const roCalls: string[] = [];
  const ro = createDashboardServer({
    ...deps,
    readOnly: true,
    setPaused: async () => {
      roCalls.push('pause');
      return 'SIG';
    },
    setDemoCrash: async () => {
      roCalls.push('crash');
    },
  });
  await new Promise<void>((r) => ro.listen(0, '127.0.0.1', r));
  const roBase = `http://127.0.0.1:${(ro.address() as AddressInfo).port}`;
  try {
    const headers = { 'content-type': 'application/json', 'x-regimeguard': '1' };
    const p = await fetch(roBase + '/api/pause', { method: 'POST', headers, body: JSON.stringify({ paused: true }) });
    const c = await fetch(roBase + '/api/demo-crash', { method: 'POST', headers, body: JSON.stringify({ on: true }) });
    assert.equal(p.status, 403);
    assert.equal(c.status, 403);
    assert.deepEqual(roCalls, []);
    const s = await fetch(roBase + '/api/state'); // reading still works
    assert.equal(s.status, 200);
  } finally {
    ro.close();
  }
});
