// devicehub self-hosted (SELF_HOSTING.md): the same Worker code on Node —
// the registry in SQLite, the hubs in the process — and real WebSockets:
// a device's socket admitted with its token gets the pushes meant for it
// (by terminal and by org tag); a follow page's socket gets order_updated;
// a bad token or ticket is refused.
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start } from '../../src/node';

const KEY = 'test-internal-key';
let base: string;
let server: ReturnType<typeof start>;

beforeAll(async () => {
  server = start({ PORT: '0', DEVICEHUB_DB: path.join(mkdtempSync(path.join(tmpdir(), 'devicehub-')), 'db.sqlite'), WS_TOKEN_SECRET: 'test-ws-secret', INTERNAL_API_KEY: KEY });
  await once(server, 'listening');
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`http://${base}${p}`, { method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

// A WebSocket client that collects what it gets.
async function socket(p: string): Promise<{ messages: any[]; ws: WebSocket }> {
  const ws = new WebSocket(`ws://${base}${p}`);
  const messages: any[] = [];
  ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('refused')));
  });
  return { messages, ws };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('devicehub on Node', () => {
  it("a device's socket: the pushes for it, by terminal and by its org's role", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    expect((await call('POST', '/devices/register', { terminal_id: 'pos-1', org_id: orgId, role: 'pos', name: 'Kassa' })).status).toBe(200);
    expect((await call('POST', '/devices/register', { terminal_id: 'cfd-1', org_id: orgId, role: 'cfd' })).status).toBe(200);
    await call('POST', '/devices/link', { pos_terminal_id: 'pos-1', terminal_id: 'cfd-1' });
    const token = async (id: string) => (await fetch(`http://${base}/devices/ws-token?terminal_id=${id}`)).json().then((b: any) => b.token as string);
    const pos = await socket(`/devices/connect?token=${encodeURIComponent(await token('pos-1'))}`);
    const cfd = await socket(`/devices/connect?token=${encodeURIComponent(await token('cfd-1'))}`);

    await call('POST', '/devices/broadcast', { pos_terminal_id: 'pos-1', event: 'payment_updated', payload: { payment_id: 'c1', method: 'cash' } });
    await call('POST', '/devices/broadcast-org', { org_id: orgId, role: 'pos', event: 'tables_changed', payload: {} });
    await settle();
    expect(pos.messages).toEqual([{ event: 'payment_updated', payment_id: 'c1', method: 'cash' }, { event: 'tables_changed' }]);
    expect(cfd.messages).toEqual([{ event: 'payment_updated', payment_id: 'c1', method: 'cash' }]);

    // Presence: both online; gone once closed.
    const online = async () => Object.fromEntries((await call('GET', `/devices/by-org/${orgId}`)).body.map((d: any) => [d.terminal_id, d.online]));
    expect(await online()).toEqual({ 'pos-1': true, 'cfd-1': true });
    cfd.ws.close();
    await settle();
    expect(await online()).toEqual({ 'pos-1': true, 'cfd-1': false });
    pos.ws.close();
  });

  it("a follow page's socket gets order_updated for its tab only", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const ticket = async (tab: string) => (await call('POST', '/orders/ticket', { org_id: orgId, tab_id: tab })).body.ticket as string;
    const mine = await socket(`/orders/connect?ticket=${encodeURIComponent(await ticket('tab-1'))}`);
    const other = await socket(`/orders/connect?ticket=${encodeURIComponent(await ticket('tab-2'))}`);
    await call('POST', '/devices/tabs-changed', { org_id: orgId, tab_ids: ['tab-1'] });
    await settle();
    expect(mine.messages).toEqual([{ event: 'order_updated' }]);
    expect(other.messages).toEqual([]);
    mine.ws.close();
    other.ws.close();
  });

  it('a bad token or ticket: refused', async () => {
    await expect(socket('/devices/connect?token=nope.nope')).rejects.toThrow('refused');
    await expect(socket('/orders/connect?ticket=nope.nope')).rejects.toThrow('refused');
    await expect(socket('/elsewhere')).rejects.toThrow('refused');
  });

  it('the registry API is for the backend only (its key)', async () => {
    expect((await fetch(`http://${base}/devices/by-org/x`)).status).toBe(401);
  });
});
