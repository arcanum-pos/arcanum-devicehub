// The D1 stand-in on SQLite (src/node/d1.ts) — what the Workers' queries
// rely on, the same as on D1: first / all / run / raw, binding, RETURNING,
// a batch as one transaction, foreign keys, and refusing `undefined`.
import { describe, expect, it } from 'vitest';
import { NodeD1Database } from '../../src/node/d1';

function db() {
  const d = new NodeD1Database(':memory:');
  d.raw.exec(`CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
              CREATE TABLE tabs (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL REFERENCES orgs(id), label TEXT, open INTEGER, UNIQUE (org_id, label));`);
  return d;
}

describe('D1 on SQLite', () => {
  it('first, all, run - with D1’s shapes', async () => {
    const d = db();
    const run = await d.prepare('INSERT INTO orgs (id, name) VALUES (?, ?)').bind('o1', 'Scouts').run();
    expect(run).toMatchObject({ success: true, meta: { changes: 1 } });
    expect(await d.prepare('SELECT * FROM orgs WHERE id = ?').bind('o1').first()).toEqual({ id: 'o1', name: 'Scouts' });
    expect(await d.prepare('SELECT name FROM orgs WHERE id = ?').bind('o1').first('name')).toBe('Scouts');
    expect(await d.prepare('SELECT * FROM orgs WHERE id = ?').bind('nope').first()).toBeNull();
    const all = await d.prepare('SELECT id FROM orgs').all();
    expect(all.results).toEqual([{ id: 'o1' }]);
    expect(await d.prepare('SELECT id, name FROM orgs').raw()).toEqual([['o1', 'Scouts']]);
  });

  it('INSERT … RETURNING gives the row; booleans become 1/0; last_row_id', async () => {
    const d = db();
    await d.prepare('INSERT INTO orgs (id, name) VALUES (?, ?)').bind('o1', 'Scouts').run();
    const inserted = await d.prepare('INSERT INTO tabs (org_id, label, open) VALUES (?, ?, ?) RETURNING id, open').bind('o1', 'Tafel 1', true).first<{ id: number; open: number }>();
    expect(inserted).toEqual({ id: 1, open: 1 });
    const second = await d.prepare('INSERT INTO tabs (org_id, label, open) VALUES (?, ?, ?)').bind('o1', 'Tafel 2', false).run();
    expect(second.meta.last_row_id).toBe(2);
  });

  it('a batch is one transaction: one failing statement undoes them all', async () => {
    const d = db();
    await d.prepare('INSERT INTO orgs (id, name) VALUES (?, ?)').bind('o1', 'Scouts').run();
    await expect(
      d.batch([
        d.prepare('INSERT INTO tabs (org_id, label) VALUES (?, ?)').bind('o1', 'A'),
        d.prepare('INSERT INTO tabs (org_id, label) VALUES (?, ?)').bind('o1', 'A'),
      ])
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect((await d.prepare('SELECT COUNT(*) AS n FROM tabs').first<{ n: number }>())!.n).toBe(0);
    const ok = await d.batch([d.prepare('INSERT INTO tabs (org_id, label) VALUES (?, ?)').bind('o1', 'B'), d.prepare('SELECT label FROM tabs')]);
    expect(ok[0].meta.changes).toBe(1);
    expect(ok[1].results).toEqual([{ label: 'B' }]);
  });

  it('foreign keys are enforced, as on D1', async () => {
    await expect(db().prepare('INSERT INTO tabs (org_id, label) VALUES (?, ?)').bind('ghost', 'x').run()).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('`undefined` is refused, as on D1', () => {
    expect(() => db().prepare('SELECT ?').bind(undefined as never)).toThrow(/D1_TYPE_ERROR/);
  });
});
