// Property-based tests (fast-check): what reaches devicehub from outside - a
// socket's token or ticket from any browser, and arcanum-backend's JSON
// bodies - is refused cleanly, never admitted or answered with a crash.
import { env, SELF } from 'cloudflare:test';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { deviceSocket, deviceTags, orderSocket } from '../src/index';

const INTERNAL = { Authorization: 'Bearer test-internal-key', 'Content-Type': 'application/json' };
const socketRequest = (param: string, value: string) =>
  new Request(`https://devicehub.test/connect?${new URLSearchParams({ [param]: value })}`, { headers: { Upgrade: 'websocket' } });

// One character of a token changed into another (the same or a '.' included).
const tampered = (token: string) =>
  fc
    .tuple(fc.nat({ max: token.length - 1 }), fc.constantFrom(...'ABCabc012-_.'))
    .map(([i, c]) => token.slice(0, i) + c + token.slice(i + 1))
    .filter((t) => t !== token);

describe('socket tokens and tickets', () => {
  let token = '';
  let ticket = '';

  beforeAll(async () => {
    const minted = await SELF.fetch('https://devicehub.test/devices/member-ws-token', { method: 'POST', headers: INTERNAL, body: JSON.stringify({ org_id: 'org-props' }) });
    token = ((await minted.json()) as { token: string }).token;
    const issued = await SELF.fetch('https://devicehub.test/orders/ticket', { method: 'POST', headers: INTERNAL, body: JSON.stringify({ org_id: 'org-props', tab_id: 'tab-1' }) });
    ticket = ((await issued.json()) as { ticket: string }).ticket;
  });

  it('a minted token and ticket are admitted (the baseline for the rest)', async () => {
    expect(await deviceSocket(socketRequest('token', token), env)).toMatchObject({ orgId: 'org-props', role: 'pos' });
    expect(await orderSocket(socketRequest('ticket', ticket), env)).toEqual({ orgId: 'org-props', tabId: 'tab-1' });
  });

  it('any other string is refused with 401', async () => {
    const candidate = fc.oneof(fc.string(), fc.tuple(fc.base64String(), fc.base64String()).map(([a, b]) => `${a}.${b}`));
    await fc.assert(
      fc.asyncProperty(candidate, async (value) => {
        for (const [param, check] of [['token', deviceSocket], ['ticket', orderSocket]] as const) {
          const result = await check(socketRequest(param, value), env);
          expect(result instanceof Response && result.status).toBe(401);
        }
      }),
    );
  });

  it('a token or ticket with any one character changed is refused', async () => {
    await fc.assert(
      fc.asyncProperty(tampered(token), async (value) => {
        const result = await deviceSocket(socketRequest('token', value), env);
        expect(result instanceof Response && result.status).toBe(401);
      }),
    );
    await fc.assert(
      fc.asyncProperty(tampered(ticket), async (value) => {
        const result = await orderSocket(socketRequest('ticket', value), env);
        expect(result instanceof Response && result.status).toBe(401);
      }),
    );
  });

  it('a device token is no order ticket, and the other way round', async () => {
    expect(((await orderSocket(socketRequest('ticket', token), env)) as Response).status).toBe(401);
    expect(((await deviceSocket(socketRequest('token', ticket), env)) as Response).status).toBe(401);
  });
});

describe('deviceTags', () => {
  it('the terminal id always first (presence relies on it); an org tag only with both org and role', () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.string(), { nil: undefined }), fc.option(fc.constantFrom('pos', 'cfd', 'station', 'tap') as fc.Arbitrary<'pos'>, { nil: undefined }), (terminalId, orgId, role) => {
        const tags = deviceTags({ terminalId, orgId, role });
        expect(tags[0]).toBe(terminalId);
        expect(tags).toHaveLength(orgId && role ? 2 : 1);
      }),
    );
  });
});

describe("arcanum-backend's requests", () => {
  // Bodies with the fields these endpoints read, each holding anything.
  const field = fc.oneof(fc.string(), fc.anything(), fc.constantFrom('pos', 'cfd', 'station', 'tap', ''));
  const body = fc.record(
    { terminal_id: field, role: field, org_id: field, name: field, pos_terminal_id: field, cfd_terminal_id: field, event: field, payload: fc.anything(), tab_ids: fc.oneof(fc.anything(), fc.array(field)), tab_id: field },
    { requiredKeys: [] },
  );
  const path = fc.constantFrom(
    '/devices/register',
    '/devices/rename',
    '/devices/link',
    '/devices/unlink',
    '/devices/reset',
    '/devices/remove',
    '/devices/broadcast',
    '/devices/broadcast-org',
    '/devices/tabs-changed',
    '/orders/ticket',
    '/devices/member-ws-token',
  );

  it('any JSON object, or no JSON at all: an answer, never an error', async () => {
    await fc.assert(
      fc.asyncProperty(path, fc.oneof(body.map((b) => JSON.stringify(b)), fc.string(), fc.constantFrom('null', '[]', '1', '"x"', 'true')), async (p, text) => {
        const res = await SELF.fetch(`https://devicehub.test${p}`, { method: 'POST', headers: INTERNAL, body: text });
        expect(res.status).toBeLessThan(500);
        await res.json();
      }),
      { numRuns: 50 },
    );
  });
});
