// Durable Objects, the part devicehub uses, in the process — for running
// self-hosted (SELF_HOSTING.md: devicehub is one replica, so one process
// holds every hub). A namespace gives the same object for the same name;
// its state keeps the hub's WebSockets with their tags (acceptWebSocket,
// getWebSockets, getTags), like Cloudflare's hibernation API. A socket here
// is a `ws` WebSocket: send() and close(), and it leaves the hub when it
// closes.

export interface HubSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  once(event: 'close', listener: () => void): unknown;
}

export class NodeHubState {
  private sockets = new Map<HubSocket, string[]>();

  acceptWebSocket(ws: HubSocket, tags: string[] = []): void {
    this.sockets.set(ws, tags);
    ws.once('close', () => this.sockets.delete(ws));
  }

  getWebSockets(tag?: string): HubSocket[] {
    return [...this.sockets].filter(([, tags]) => tag === undefined || tags.includes(tag)).map(([ws]) => ws);
  }

  getTags(ws: HubSocket): string[] {
    return this.sockets.get(ws) ?? [];
  }
}

interface HubObject {
  fetch(request: Request): Promise<Response>;
}

export class NodeNamespace<T extends HubObject> {
  private objects = new Map<string, { object: T; state: NodeHubState }>();

  constructor(private readonly create: (state: NodeHubState) => T) {}

  idFromName(name: string): { name: string; toString(): string } {
    return { name, toString: () => name };
  }

  get(id: { name: string }): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } {
    const { object } = this.instance(id.name);
    return { fetch: (input, init) => object.fetch(new Request(input, init)) };
  }

  // The object and its state by name (node.ts adds the sockets to it).
  instance(name: string): { object: T; state: NodeHubState } {
    let entry = this.objects.get(name);
    if (!entry) {
      const state = new NodeHubState();
      entry = { object: this.create(state), state };
      this.objects.set(name, entry);
    }
    return entry;
  }
}
