// arcanum-devicehub self-hosted (SELF_HOSTING.md): the same Worker code
// (index.ts) on Node — its registry in a SQLite file (node/d1.ts), the
// DeviceHub and OrderHub objects in this process (node/durable-objects.ts).
// From the environment (the installer sets them):
//   WS_TOKEN_SECRET, INTERNAL_API_KEY   as on Cloudflare (required)
//   DEVICEHUB_DB                        the registry's SQLite file (default /data/devicehub.db)
//   PORT                                to listen on (default 8080)
//
// A socket arrives as an HTTP upgrade (the bff passes it on as is): the
// same checks as on Cloudflare (deviceSocket / orderSocket), then into the
// hub with the same tags — so the Worker's pushes reach it unchanged.
import { serve } from '@hono/node-server';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import worker, { DEVICE_HUB_NAME, DeviceHub, deviceSocket, deviceTags, MAX_FOLLOWERS, orderHubName, OrderHub, orderSocket, type Env } from './index';
import { NodeD1Database } from './node/d1';
import { NodeNamespace } from './node/durable-objects';
import schema from '../schema.sql';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function nodeEnv(environment: NodeJS.ProcessEnv) {
  const db = new NodeD1Database(environment.DEVICEHUB_DB || '/data/devicehub.db');
  // No migrations here: the schema is CREATE … IF NOT EXISTS throughout.
  db.raw.exec(schema);
  const deviceHubs = new NodeNamespace((state) => new DeviceHub(state as unknown as DurableObjectState));
  const orderHubs = new NodeNamespace((state) => new OrderHub(state as unknown as DurableObjectState));
  const env = {
    DB: db as unknown as D1Database,
    DEVICE_HUB: deviceHubs as unknown as DurableObjectNamespace,
    ORDER_HUB: orderHubs as unknown as DurableObjectNamespace,
    WS_TOKEN_SECRET: required(environment, 'WS_TOKEN_SECRET'),
    INTERNAL_API_KEY: required(environment, 'INTERNAL_API_KEY'),
  } satisfies Env;
  return { env, db, deviceHubs, orderHubs };
}

// The upgrade as a Request, for the shared checks (only its URL and headers matter).
function requestOf(req: IncomingMessage): Request {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  return new Request(new URL(req.url || '/', 'http://devicehub'), { headers });
}

function refuse(socket: Duplex, response: Response) {
  socket.end(`HTTP/1.1 ${response.status} ${response.statusText || 'Refused'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function start(environment: NodeJS.ProcessEnv = process.env) {
  const { env, deviceHubs, orderHubs } = nodeEnv(environment);
  const sockets = new WebSocketServer({ noServer: true });
  const port = Number(environment.PORT || 8080);
  const server = serve({ fetch: (request) => worker.fetch(request, env), port }, () => console.log(`arcanum-devicehub listening on :${port}`));

  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const request = requestOf(req);
    const path = new URL(request.url).pathname;
    if (path === '/devices/connect') {
      const device = await deviceSocket(request, env);
      if (device instanceof Response) return refuse(socket, device);
      const hub = deviceHubs.instance(DEVICE_HUB_NAME);
      sockets.handleUpgrade(req, socket, head, (ws) => hub.state.acceptWebSocket(ws, deviceTags(device)));
      return;
    }
    if (path === '/orders/connect') {
      const order = await orderSocket(request, env);
      if (order instanceof Response) return refuse(socket, order);
      const hub = orderHubs.instance(orderHubName(order.orgId));
      if (hub.state.getWebSockets().length >= MAX_FOLLOWERS) return refuse(socket, new Response(null, { status: 503, statusText: 'Too many followers' }));
      sockets.handleUpgrade(req, socket, head, (ws) => hub.state.acceptWebSocket(ws, [order.tabId]));
      return;
    }
    refuse(socket, new Response(null, { status: 404, statusText: 'Not Found' }));
  });
  return server;
}
