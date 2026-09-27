// Org-wide pushes (/devices/broadcast-org): every socket is tagged with its
// terminal id and, when its token carries the device's org, with
// `org:<org_id>:<role>` — so the payment worker can reach every kassa of one
// org at once (tabs_changed) without knowing their terminal ids.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

type Role = 'pos' | 'cfd' | 'sim';

function randomId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`https://devicehub.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

const INTERNAL = { Authorization: 'Bearer test-internal-key' };

async function register(role: Role, orgId: string) {
  const terminalId = randomId(role);
  const res = await call('POST', '/devices/register', { terminal_id: terminalId, role, org_id: orgId });
  expect(res.status).toBe(200);
  return terminalId;
}

async function wsToken(terminalId: string): Promise<string> {
  const res = await call('GET', `/devices/ws-token?terminal_id=${encodeURIComponent(terminalId)}`);
  expect(res.status).toBe(200);
  return res.body.token;
}

function tokenPayload(token: string) {
  const [body] = token.split('.');
  const padded = body.replace(/-/g, '+').replace(/_/g, '/').padEnd(body.length + ((4 - (body.length % 4)) % 4), '=');
  return JSON.parse(atob(padded));
}

// A token as devicehub minted them before org_id existed — signed with the
// same secret, just without the field.
async function legacyToken(terminalId: string, role: Role): Promise<string> {
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = encode(new TextEncoder().encode(JSON.stringify({ terminal_id: terminalId, role, exp: Date.now() + 60_000 })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.WS_TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))));
  return `${body}.${sig}`;
}

interface Socket {
  messages: any[];
  close(): void;
}

async function connect(token: string): Promise<Socket> {
  const res = await SELF.fetch(`https://devicehub.test/devices/connect?token=${encodeURIComponent(token)}`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const messages: any[] = [];
  ws.addEventListener('message', (e) => {
    messages.push(JSON.parse(e.data as string));
  });
  return { messages, close: () => ws.close() };
}

async function connectDevice(role: Role, orgId: string) {
  const terminalId = await register(role, orgId);
  return { terminalId, socket: await connect(await wsToken(terminalId)) };
}

function broadcastOrg(body: unknown, headers: Record<string, string> = INTERNAL) {
  return call('POST', '/devices/broadcast-org', body, headers);
}

// Messages arrive asynchronously after the push call returns.
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
}

describe('ws token', () => {
  it("carries the device's org_id and role", async () => {
    const orgId = randomId('org');
    const terminalId = await register('pos', orgId);
    const payload = tokenPayload(await wsToken(terminalId));
    expect(payload).toMatchObject({ terminal_id: terminalId, role: 'pos', org_id: orgId });
  });

  it('refuses a missing or tampered token', async () => {
    const res = await SELF.fetch('https://devicehub.test/devices/connect?token=nope.nope', { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(401);
  });
});

describe('POST /devices/broadcast-org', () => {
  it("reaches every POS of that org — not another org's, not a CFD of the same org", async () => {
    const orgId = randomId('org');
    const posA = await connectDevice('pos', orgId);
    const posB = await connectDevice('pos', orgId);
    const cfd = await connectDevice('cfd', orgId);
    const otherPos = await connectDevice('pos', randomId('org'));

    const res = await broadcastOrg({ org_id: orgId, event: 'tabs_changed', payload: { tab_id: 't1' } });
    expect(res).toEqual({ status: 200, body: { ok: true, delivered: 2 } });
    await settle();

    expect(posA.socket.messages).toEqual([{ event: 'tabs_changed', tab_id: 't1' }]);
    expect(posB.socket.messages).toEqual([{ event: 'tabs_changed', tab_id: 't1' }]);
    expect(cfd.socket.messages).toEqual([]);
    expect(otherPos.socket.messages).toEqual([]);
    for (const d of [posA, posB, cfd, otherPos]) d.socket.close();
  });

  it('reaches another role when asked', async () => {
    const orgId = randomId('org');
    const pos = await connectDevice('pos', orgId);
    const cfd = await connectDevice('cfd', orgId);

    const res = await broadcastOrg({ org_id: orgId, role: 'cfd', event: 'hello' });
    expect(res.body).toEqual({ ok: true, delivered: 1 });
    await settle();
    expect(cfd.socket.messages).toEqual([{ event: 'hello' }]);
    expect(pos.socket.messages).toEqual([]);
    pos.socket.close();
    cfd.socket.close();
  });

  it('delivers to nobody when the org has no sockets', async () => {
    expect((await broadcastOrg({ org_id: randomId('org'), event: 'tabs_changed' })).body).toEqual({ ok: true, delivered: 0 });
  });

  it('needs the internal key', async () => {
    const body = { org_id: 'o', event: 'tabs_changed' };
    expect((await broadcastOrg(body, {})).status).toBe(401);
    expect((await broadcastOrg(body, { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('needs org_id and event, and a known role', async () => {
    expect((await broadcastOrg({ event: 'tabs_changed' })).status).toBe(400);
    expect((await broadcastOrg({ org_id: 'o' })).status).toBe(400);
    expect((await broadcastOrg({ org_id: 'o', event: 'x', role: 'kitchen' })).status).toBe(400);
  });
});

describe('old-style tokens (no org_id)', () => {
  it('still connect and get per-terminal pushes, just no org-wide ones', async () => {
    const orgId = randomId('org');
    const terminalId = await register('pos', orgId);
    const socket = await connect(await legacyToken(terminalId, 'pos'));

    expect((await broadcastOrg({ org_id: orgId, event: 'tabs_changed' })).body.delivered).toBe(0);
    const res = await call('POST', '/devices/broadcast', { pos_terminal_id: terminalId, event: 'payment_updated', payload: { payment_id: 'p1' } }, INTERNAL);
    expect(res.status).toBe(200);
    await settle();
    expect(socket.messages).toEqual([{ event: 'payment_updated', payment_id: 'p1' }]);
    socket.close();
  });
});

describe('presence', () => {
  it('still lists plain terminal ids, never the org tags', async () => {
    const orgId = randomId('org');
    const pos = await connectDevice('pos', orgId);
    const cfd = await connectDevice('cfd', orgId);

    const res = await call('GET', `/devices/by-org/${orgId}`);
    expect(res.body.map((d: any) => [d.terminal_id, d.online]).sort()).toEqual([
      [cfd.terminalId, true],
      [pos.terminalId, true],
    ].sort());
    // listUnlinked compares presence to terminal ids — the connected CFD shows up.
    const unlinked = await call('GET', `/devices/unlinked?role=cfd&org_id=${orgId}`);
    expect(unlinked.body.map((d: any) => d.terminal_id)).toEqual([cfd.terminalId]);

    const presence = await (await env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName('singleton')).fetch('https://device-hub/presence')).json<{ connected: string[] }>();
    expect(presence.connected).toContain(pos.terminalId);
    expect(presence.connected.some((id) => id.startsWith('org:'))).toBe(false);
    pos.socket.close();
    cfd.socket.close();
  });
});
