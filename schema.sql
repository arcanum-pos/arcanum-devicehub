-- Registered POS/CFD/sim terminals. A CFD/sim sits idle (linked_to IS NULL)
-- until a POS links it to itself. org_id scopes every device to one
-- organization (see worker/src/organizations — a separate Worker/database;
-- this table just stores the id, it doesn't verify membership itself).
-- Nullable for backward compatibility with devices registered before
-- organizations existed; new registrations always require it.
CREATE TABLE IF NOT EXISTS devices (
  terminal_id TEXT PRIMARY KEY,
  org_id TEXT,
  role TEXT NOT NULL,
  linked_to TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_role_linked_to ON devices(role, linked_to);
CREATE INDEX IF NOT EXISTS idx_devices_org ON devices(org_id);
