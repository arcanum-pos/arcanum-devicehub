// questo-devicehub: the notification channel, kept deliberately separate from
// the payment-processing worker. Owns device identity/linking (D1) and the
// live WebSocket relay (DeviceHub Durable Object). Never touches payment
// amounts or the transactions log — it only ever relays an event name + id;
// every real read/write still goes back through the BFF with a full session
// check. See LOCAL_DEV.md at the repo root for how this fits with the other
// three Workers.

export interface Env {
  DB: D1Database;
  DEVICE_HUB: DurableObjectNamespace;
  WS_TOKEN_SECRET: string;
  // Shared secret for the payment worker's server-to-server calls to
  // /devices/broadcast — distinct from the BFF's session-based access to
  // every other route here, and distinct from WS_TOKEN_SECRET (that one only
  // ever admits a socket, this one authorizes triggering a push).
  INTERNAL_API_KEY: string;
  // Base URL this Worker is reachable at, used to build the ws:// URL handed
  // back to POS/CFD/sim clients. Update to the real public URL on deploy.
  WORKER_PUBLIC_URL: string;
}

type Role = 'pos' | 'cfd' | 'sim';
const DEVICE_ROLES = new Set<Role>(['pos', 'cfd', 'sim']);
const LINKABLE_ROLES = new Set<Role>(['cfd', 'sim']);

interface DeviceRow {
  terminal_id: string;
  org_id: string | null;
  role: Role;
  linked_to: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function isRole(value: string | null): value is Role {
  return value !== null && DEVICE_ROLES.has(value as Role);
}

function isLinkableRole(value: string | null): value is 'cfd' | 'sim' {
  return value !== null && LINKABLE_ROLES.has(value as Role);
}

// --- Device registry (D1) ---

async function registerDevice(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { terminal_id?: string; role?: string; org_id?: string };
  const terminalId = String(body.terminal_id || '');
  const role = body.role || '';
  const orgId = String(body.org_id || '');

  if (!terminalId) return json({ error: 'terminal_id is required' }, 400);
  if (!isRole(role)) return json({ error: "role must be 'pos', 'cfd' or 'sim'" }, 400);
  if (!orgId) return json({ error: 'org_id is required' }, 400);

  const existing = await getDeviceRow(env, terminalId);
  if (!existing) {
    await env.DB.prepare('INSERT INTO devices (terminal_id, org_id, role, linked_to, created_at) VALUES (?, ?, ?, NULL, ?)')
      .bind(terminalId, orgId, role, new Date().toISOString())
      .run();
  }

  return json(await getDeviceRow(env, terminalId));
}

async function getDeviceRow(env: Env, terminalId: string): Promise<DeviceRow | null> {
  return env.DB.prepare('SELECT terminal_id, org_id, role, linked_to FROM devices WHERE terminal_id = ?')
    .bind(terminalId)
    .first<DeviceRow>();
}

async function getDevice(terminalId: string, env: Env): Promise<Response> {
  const row = await getDeviceRow(env, terminalId);
  if (!row) return json({ error: 'Unknown terminal_id' }, 404);
  return json(row);
}

async function listUnlinked(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const role = params.get('role');
  const orgId = params.get('org_id');
  if (!isLinkableRole(role)) return json({ error: "role must be 'cfd' or 'sim'" }, 400);
  if (!orgId) return json({ error: 'org_id is required' }, 400);

  const { results } = await env.DB.prepare(
    'SELECT terminal_id, created_at FROM devices WHERE role = ? AND org_id = ? AND linked_to IS NULL ORDER BY created_at DESC'
  )
    .bind(role, orgId)
    .all();
  return json(results || []);
}

// For the admin portal's "devices linked to this organization" list. Not
// scoped to any particular POS — every device (any role, linked or not)
// registered under this org.
async function listByOrg(orgId: string, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT terminal_id, role, linked_to, created_at FROM devices WHERE org_id = ? ORDER BY created_at DESC'
  )
    .bind(orgId)
    .all();
  return json(results || []);
}

async function getLinkedDevice(request: Request, posTerminalId: string, env: Env): Promise<Response> {
  const role = new URL(request.url).searchParams.get('role');
  if (!isLinkableRole(role)) return json({ error: "role must be 'cfd' or 'sim'" }, 400);

  const row = await env.DB.prepare('SELECT terminal_id, role, linked_to FROM devices WHERE role = ? AND linked_to = ?')
    .bind(role, posTerminalId)
    .first<DeviceRow>();
  return json(row || null);
}

async function linkDevice(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { pos_terminal_id?: string; terminal_id?: string };
  const posTerminalId = String(body.pos_terminal_id || '');
  const targetTerminalId = String(body.terminal_id || '');
  if (!posTerminalId || !targetTerminalId) {
    return json({ error: 'pos_terminal_id and terminal_id are required' }, 400);
  }

  const target = await getDeviceRow(env, targetTerminalId);
  if (!target || !isLinkableRole(target.role)) {
    return json({ error: 'Unknown or non-linkable terminal_id' }, 404);
  }

  const pos = await getDeviceRow(env, posTerminalId);
  if (!pos) return json({ error: 'Unknown pos_terminal_id' }, 404);
  if (pos.org_id !== target.org_id) {
    return json({ error: 'Cannot link devices from different organizations' }, 400);
  }

  await env.DB.prepare('UPDATE devices SET linked_to = ? WHERE terminal_id = ?').bind(posTerminalId, targetTerminalId).run();
  await pushToDevice(env, targetTerminalId, 'linked', { pos_terminal_id: posTerminalId });
  // Also tell the POS itself — its own Instellingen page (if open, e.g. in a
  // separate tab from wherever the link was made — the kassa's "Klantscherm
  // openen" button, or another browser entirely) has no other way to learn a
  // link changed, since it only re-fetches on page load or a manual refresh.
  await pushToDevice(env, posTerminalId, 'links_changed', {});

  return json(await getDeviceRow(env, targetTerminalId));
}

async function unlinkDevice(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { terminal_id?: string };
  const targetTerminalId = String(body.terminal_id || '');
  if (!targetTerminalId) return json({ error: 'terminal_id is required' }, 400);

  // Captured before clearing it — needed to notify the POS that *was* linked,
  // same reasoning as the notification added to linkDevice above.
  const existing = await getDeviceRow(env, targetTerminalId);
  const previousPosTerminalId = existing?.linked_to || null;

  await env.DB.prepare('UPDATE devices SET linked_to = NULL WHERE terminal_id = ?').bind(targetTerminalId).run();
  await pushToDevice(env, targetTerminalId, 'unlinked', {});
  if (previousPosTerminalId) {
    await pushToDevice(env, previousPosTerminalId, 'links_changed', {});
  }

  return json(await getDeviceRow(env, targetTerminalId));
}

// Prunes registrations of the given (linkable) role that don't currently have
// a live notification socket. Not applied to 'pos': that's the identity
// things link TO, not something chosen from a list.
async function pruneStale(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const role = params.get('role');
  const orgId = params.get('org_id');
  if (!isLinkableRole(role)) return json({ error: "role must be 'cfd' or 'sim'" }, 400);
  if (!orgId) return json({ error: 'org_id is required' }, 400);

  const connected = await getConnectedTerminalIds(env);
  const { results } = await env.DB.prepare('SELECT terminal_id FROM devices WHERE role = ? AND org_id = ?')
    .bind(role, orgId)
    .all<{
      terminal_id: string;
    }>();
  const stale = (results || []).map((r) => r.terminal_id).filter((id) => !connected.has(id));

  if (stale.length > 0) {
    const placeholders = stale.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM devices WHERE terminal_id IN (${placeholders})`)
      .bind(...stale)
      .run();
  }

  return json({ removed: stale });
}

// --- Broadcasting ---
// Pushes an event to a POS itself, plus whichever CFD/sim are currently
// linked to it. Used both by /devices/reset (webapp, via the BFF) and by
// /devices/broadcast (the payment worker, server-to-server) — same fan-out,
// different callers.
async function broadcastToPos(env: Env, posTerminalId: string, event: string, payload: Record<string, unknown>) {
  await pushToDevice(env, posTerminalId, event, payload);
  for (const role of LINKABLE_ROLES) {
    const row = await env.DB.prepare('SELECT terminal_id FROM devices WHERE role = ? AND linked_to = ?')
      .bind(role, posTerminalId)
      .first<{ terminal_id: string }>();
    if (row) await pushToDevice(env, row.terminal_id, event, payload);
  }
}

async function resetEndpoint(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { pos_terminal_id?: string };
  const posTerminalId = String(body.pos_terminal_id || '');
  if (!posTerminalId) return json({ error: 'pos_terminal_id is required' }, 400);

  await broadcastToPos(env, posTerminalId, 'reset', {});
  return json({ ok: true });
}

function requireInternalKey(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(env.INTERNAL_API_KEY) && token === env.INTERNAL_API_KEY;
}

// Called by the payment worker (service binding, bearer-authenticated with
// INTERNAL_API_KEY) whenever a charge is created or resolved.
async function broadcastEndpoint(request: Request, env: Env): Promise<Response> {
  if (!requireInternalKey(request, env)) return json({ error: 'Unauthorized' }, 401);

  const body = (await request.json().catch(() => ({}))) as {
    pos_terminal_id?: string;
    event?: string;
    payload?: Record<string, unknown>;
  };
  const posTerminalId = String(body.pos_terminal_id || '');
  const event = String(body.event || '');
  if (!posTerminalId || !event) return json({ error: 'pos_terminal_id and event are required' }, 400);

  await broadcastToPos(env, posTerminalId, event, body.payload || {});
  return json({ ok: true });
}

// --- Notification-channel tokens ---
// Short-lived, signed, and checked with plain HMAC verification (no KV, no
// session) — deliberately low-privilege, since this token only ever admits a
// socket into DeviceHub. It carries no authority to read or change real data.

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  bytes.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const WS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour; client refreshes as it nears expiry

interface WsTokenPayload {
  terminal_id: string;
  role: Role;
  exp: number;
}

async function mintWsToken(terminalId: string, role: Role, env: Env): Promise<string> {
  const payload: WsTokenPayload = { terminal_id: terminalId, role, exp: Date.now() + WS_TOKEN_TTL_MS };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(body, env.WS_TOKEN_SECRET);
  return `${body}.${sig}`;
}

async function verifyWsToken(token: string | null, env: Env): Promise<WsTokenPayload | null> {
  if (!token || !env.WS_TOKEN_SECRET) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expected = await hmacSign(body, env.WS_TOKEN_SECRET);
  if (!timingSafeEqual(expected, sig)) return null;

  let payload: WsTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as WsTokenPayload;
  } catch {
    return null;
  }
  if (!payload.terminal_id || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

async function issueWsToken(request: Request, env: Env): Promise<Response> {
  const terminalId = new URL(request.url).searchParams.get('terminal_id');
  if (!terminalId) return json({ error: 'terminal_id is required' }, 400);

  const device = await getDeviceRow(env, terminalId);
  if (!device) return json({ error: 'Unknown terminal_id' }, 404);

  const token = await mintWsToken(terminalId, device.role, env);
  const wsUrl = `${env.WORKER_PUBLIC_URL.replace(/^http/, 'ws')}/devices/connect`;
  return json({ token, wsUrl });
}

async function connectDevice(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token');
  const payload = await verifyWsToken(token, env);
  if (!payload) return json({ error: 'Invalid or expired token' }, 401);
  if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected websocket upgrade' }, 426);

  const stub = getDeviceHub(env);
  const doUrl = new URL('https://device-hub/connect');
  doUrl.searchParams.set('terminal_id', payload.terminal_id);
  return stub.fetch(new Request(doUrl, request));
}

function getDeviceHub(env: Env): DurableObjectStub {
  const id = env.DEVICE_HUB.idFromName('singleton');
  return env.DEVICE_HUB.get(id);
}

async function pushToDevice(env: Env, terminalId: string, event: string, payload: Record<string, unknown>) {
  const stub = getDeviceHub(env);
  await stub.fetch('https://device-hub/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal_id: terminalId, event, ...payload }),
  });
}

async function getConnectedTerminalIds(env: Env): Promise<Set<string>> {
  const stub = getDeviceHub(env);
  const res = await stub.fetch('https://device-hub/presence');
  const { connected } = (await res.json()) as { connected: string[] };
  return new Set(connected || []);
}

// --- DeviceHub Durable Object ---
// One per deployment: device counts here are small (a handful of POS/CFD/sim
// terminals), so a single coordinator is simpler than routing by venue.

export class DeviceHub implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      const terminalId = url.searchParams.get('terminal_id');
      if (!terminalId) return json({ error: 'terminal_id is required' }, 400);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [terminalId]);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST' && url.pathname === '/notify') {
      const { terminal_id, event, ...rest } = (await request.json()) as { terminal_id: string; event: string };
      const sockets = this.state.getWebSockets(terminal_id);
      const message = JSON.stringify({ event, ...rest });
      for (const ws of sockets) {
        try {
          ws.send(message);
        } catch {
          // socket already gone; webSocketClose/hibernation cleans it up
        }
      }
      return json({ delivered: sockets.length });
    }

    if (request.method === 'GET' && url.pathname === '/presence') {
      const ids = new Set<string>();
      for (const ws of this.state.getWebSockets()) {
        for (const tag of this.state.getTags(ws)) ids.add(tag);
      }
      return json({ connected: [...ids] });
    }

    return json({ error: 'Not found' }, 404);
  }

  // Notification channel is one-way (server → client); nothing to react to here.
  async webSocketMessage() {}

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  async webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, 'error');
    } catch {
      // already closing
    }
  }
}

// --- Routing ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: json({}).headers });

    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/devices/register') return await registerDevice(request, env);
      if (request.method === 'GET' && url.pathname === '/devices/unlinked') return await listUnlinked(request, env);
      if (request.method === 'POST' && url.pathname === '/devices/link') return await linkDevice(request, env);
      if (request.method === 'POST' && url.pathname === '/devices/unlink') return await unlinkDevice(request, env);
      if (request.method === 'POST' && url.pathname === '/devices/reset') return await resetEndpoint(request, env);
      if (request.method === 'POST' && url.pathname === '/devices/prune') return await pruneStale(request, env);
      if (request.method === 'POST' && url.pathname === '/devices/broadcast') return await broadcastEndpoint(request, env);
      if (request.method === 'GET' && url.pathname === '/devices/ws-token') return await issueWsToken(request, env);
      if (url.pathname === '/devices/connect') return await connectDevice(request, env);

      const byOrgMatch = url.pathname.match(/^\/devices\/by-org\/([^/]+)$/);
      if (request.method === 'GET' && byOrgMatch) return await listByOrg(decodeURIComponent(byOrgMatch[1]), env);

      const linkedMatch = url.pathname.match(/^\/devices\/([^/]+)\/linked$/);
      if (request.method === 'GET' && linkedMatch) return await getLinkedDevice(request, decodeURIComponent(linkedMatch[1]), env);

      const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)$/);
      if (request.method === 'GET' && deviceMatch) return await getDevice(decodeURIComponent(deviceMatch[1]), env);

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'Unexpected devicehub error', details: (err as Error).message }, 502);
    }
  },
};
