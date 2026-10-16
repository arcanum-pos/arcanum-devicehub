# arcanum-devicehub

The notification channel: device identity (kassa `pos`, customer display
`cfd`, station screen `station`) and two hibernating Durable Objects that
only ever relay an event name + id — the data is always fetched separately:

- **DeviceHub** (one): the devices' sockets (`/devices/connect`, a signed
  device token), tagged per org and role.
- **OrderHub** (one per org, 2026-10-11): guests' "follow your order" pages
  (`/orders/connect`, a signed ticket for one tab that arcanum-backend asks
  for with `/orders/ticket`), at most 2000 sockets.

`/devices/tabs-changed` (arcanum-backend, internal key) tells both at once:
`tabs_changed` to the org's kassas and station screens, `order_updated` to
the pages following those tabs. DOMAIN_MODEL.md "Self-ordering and station
screens".

## License

Copyright (C) 2026 kaboutersoft.be

Arcanum is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

In short: free to use, self-host, modify, host for others and charge for
hosting or support — but if you run a modified version for users over a
network, you must offer those users its source code (AGPL §13). The app's
"Broncode" link (the `SOURCE_URL` setting of arcanum-bff) is how an
installation points its users to that source.

## Self-hosted (SELF_HOSTING.md)

The same Worker code runs on Node (`src/node.ts`): `npm run build:node`,
then `node dist/node.mjs` with `WS_TOKEN_SECRET`, `INTERNAL_API_KEY`,
`DEVICEHUB_DB` (its SQLite file) and `PORT`. The registry is D1 on SQLite
(`src/node/d1.ts`, the schema applied at start); DeviceHub and OrderHub live
in the process (`src/node/durable-objects.ts`, one replica). Sockets arrive
as HTTP upgrades and are admitted by the same checks as on Cloudflare
(`deviceSocket` / `orderSocket`), with the same tags. `npm test` runs the
Worker tests in the Workers runtime and `test/node/` on Node — real
WebSockets included.
