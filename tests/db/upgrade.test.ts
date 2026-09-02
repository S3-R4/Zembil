/**
 * Upgrading an EXISTING database in place — the actual deployment path.
 *
 * Every other migration test starts from an empty file, which is the one case
 * that cannot lose anybody's data. The deployed database is not empty: it has
 * accounts, shops, closed trips and carry lineage in it, and migrations 002 and
 * 003 run automatically at process start (§6) against exactly that. D-013's
 * promised pre-migration snapshot still does not happen (PROJECT.md §13), so
 * there is no automatic undo — which makes this the test that stands in for one.
 *
 * The assertions are deliberately about what must NOT change. A migration that
 * adds a column is easy to get right and easy to be sure about; what is worth
 * pinning is that nothing was silently rewritten on the way past.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_VERSION, getUserVersion, migrate } from '$lib/server/db/migrations';
import { NAME_KEY_SEPARATOR } from '$lib/server/domain/validate';

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'zembil-upgrade-'));
	file = join(dir, 'zembil.db');
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A database as it stands on the deployed server: migration 001 only, with
 *  three accounts, three shops, a closed trip and items. */
function buildM5Database(): DatabaseSync {
	const db = new DatabaseSync(file);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec(readFileSync('src/lib/server/db/migrations/001_initial.sql', 'utf8'));
	db.exec('PRAGMA user_version = 1');

	const now = Date.now();
	const userIds: string[] = [];
	for (const [username, display, isAdmin] of [
		['admin', 'Ahmet', 1],
		['ayse', 'Ayse', 0],
		['dede', 'Dede', 0]
	] as const) {
		const id = randomUUID();
		db.prepare(
			`INSERT INTO users (id, username, username_key, display_name, password_hash, is_admin,
			                    is_active, must_change_password, webauthn_user_handle, created_at,
			                    updated_at, disabled_at)
			 VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL)`
		).run(
			id,
			username,
			username.toLowerCase(),
			display,
			'scrypt$N=65536,r=8,p=1$c2FsdA$a2V5',
			isAdmin,
			randomBytes(32),
			now,
			now
		);
		userIds.push(id);
	}

	// A name with a dotted capital I, because `name_key` normalisation is
	// application-owned (§1.1) and migration 003 rewrites that column for
	// private stores. A re-key that mangled Turkish is exactly what an
	// empty-database test never sees.
	const names = [
		['Migros', 'terracotta'],
		['Eczane', 'green'],
		['BİM', 'violet']
	] as const;

	for (const [i, [name, color]] of names.entries()) {
		const storeId = randomUUID();
		db.prepare(
			`INSERT INTO stores (id, name, name_key, color, sort_order, rev, created_at, created_by, archived_at)
			 VALUES (?, ?, ?, ?, ?, 7, ?, ?, NULL)`
		).run(
			storeId,
			name,
			name.normalize('NFKC').toLowerCase(),
			color,
			1000 * (i + 1),
			now,
			userIds[0]
		);

		// The first shop gets history: a closed trip plus its successor.
		const first = randomUUID();
		db.prepare(
			`INSERT INTO trips (id, store_id, seq, status, opened_at, closed_at, closed_by)
			 VALUES (?, ?, 1, ?, ?, ?, ?)`
		).run(
			first,
			storeId,
			i === 0 ? 'closed' : 'open',
			now,
			i === 0 ? now : null,
			i === 0 ? userIds[1] : null
		);

		let target = first;
		if (i === 0) {
			target = randomUUID();
			db.prepare(
				`INSERT INTO trips (id, store_id, seq, status, opened_at, closed_at, closed_by)
				 VALUES (?, ?, 2, 'open', ?, NULL, NULL)`
			).run(target, storeId, now);
		}

		const itemId = randomUUID();
		db.prepare(
			`INSERT INTO items (id, trip_id, store_id, client_id, name, note, state, sort_order,
			                    ticked_at, ticked_by, carried_from_item_id, carried_to_item_id,
			                    origin_item_id, carry_count, version, created_at, created_by,
			                    updated_at, deleted_at)
			 VALUES (?, ?, ?, ?, ?, '2 litre', 'pending', 1000, NULL, NULL, NULL, NULL, ?, 0, 1, ?, ?, ?, NULL)`
		).run(itemId, target, storeId, randomUUID(), `Item ${i}`, itemId, now, userIds[1], now);
	}

	return db;
}

interface Snapshot {
	users: unknown[];
	stores: unknown[];
	trips: unknown[];
	items: unknown[];
}

function snapshot(db: DatabaseSync): Snapshot {
	return {
		users: db
			.prepare('SELECT id, username, username_key, display_name, is_admin FROM users ORDER BY id')
			.all(),
		stores: db
			.prepare('SELECT id, name, name_key, color, sort_order, rev FROM stores ORDER BY id')
			.all(),
		trips: db.prepare('SELECT id, store_id, seq, status, closed_by FROM trips ORDER BY id').all(),
		items: db
			.prepare(
				'SELECT id, trip_id, store_id, name, note, state, sort_order, version FROM items ORDER BY id'
			)
			.all()
	};
}

describe('an existing database upgrades in place without losing anything', () => {
	test('001 to latest keeps every row byte-for-byte', () => {
		const built = buildM5Database();
		const before = snapshot(built);
		built.close();

		const db = new DatabaseSync(file);
		db.exec('PRAGMA foreign_keys = ON');
		expect(getUserVersion(db)).toBe(1);

		const result = migrate(db);
		expect(result.from).toBe(1);
		expect(result.to).toBe(LATEST_VERSION);

		// Nothing rewritten. `name_key` in particular: migration 003 re-keys
		// private stores, and every store here is public, so every key must be
		// exactly as it was — including the Turkish one.
		expect(snapshot(db)).toEqual(before);
		db.close();
	});

	test('existing accounts default to English and existing shops stay public', () => {
		buildM5Database().close();
		const db = new DatabaseSync(file);
		db.exec('PRAGMA foreign_keys = ON');
		migrate(db);

		const locales = db.prepare('SELECT DISTINCT locale FROM users').all() as Array<{
			locale: string;
		}>;
		expect(locales.map((r) => r.locale)).toEqual(['en']);

		// The owner's brief: public by default. An upgrade that privatised
		// anything would hide a shop from the family with no way back through the
		// UI (D-040).
		const priv = db
			.prepare('SELECT COUNT(*) AS n FROM stores WHERE private_to IS NOT NULL')
			.get() as { n: number };
		expect(Number(priv.n)).toBe(0);

		// And nobody arrives already "shopping".
		const claimed = db
			.prepare('SELECT COUNT(*) AS n FROM trips WHERE claimed_by IS NOT NULL')
			.get() as { n: number };
		expect(Number(claimed.n)).toBe(0);
		db.close();
	});

	test('the upgraded file passes integrity and foreign-key checks', () => {
		buildM5Database().close();
		const db = new DatabaseSync(file);
		db.exec('PRAGMA foreign_keys = ON');
		migrate(db);

		expect(
			(db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
		).toBe('ok');
		// Migration 002 adds three foreign keys to already-populated tables, and
		// SQLite does not verify those against existing rows on its own.
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		db.close();
	});

	test('re-running on an already-upgraded file is a no-op', () => {
		buildM5Database().close();
		const db = new DatabaseSync(file);
		db.exec('PRAGMA foreign_keys = ON');
		migrate(db);
		const after = snapshot(db);

		// A container restart re-enters `migrate()` on every boot.
		const again = migrate(db);
		expect(again.applied).toEqual([]);
		expect(again.from).toBe(LATEST_VERSION);
		expect(snapshot(db)).toEqual(after);
		db.close();
	});

	test('migration 003 re-keys a private store, and only a private store', () => {
		buildM5Database().close();
		const db = new DatabaseSync(file);
		db.exec('PRAGMA foreign_keys = ON');

		// Upgrade to 2 only, then privatise a shop the way migration 002 leaves
		// it — with an unscoped key — so 003 has something real to re-key. This
		// cannot arise on the deployed database, where visibility and the re-key
		// ship together, and would arise on any database upgraded in two steps.
		db.exec('BEGIN IMMEDIATE');
		db.exec(
			readFileSync('src/lib/server/db/migrations/002_claims_visibility_locale_push.sql', 'utf8')
		);
		db.exec('PRAGMA user_version = 2');
		db.exec('COMMIT');

		const owner = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;
		const store = db.prepare('SELECT id, name_key FROM stores ORDER BY name LIMIT 1').get() as {
			id: string;
			name_key: string;
		};
		db.prepare('UPDATE stores SET private_to = ? WHERE id = ?').run(owner, store.id);
		const publicKeysBefore = db
			.prepare('SELECT id, name_key FROM stores WHERE private_to IS NULL ORDER BY id')
			.all();

		migrate(db);

		const after = db.prepare('SELECT name_key FROM stores WHERE id = ?').get(store.id) as {
			name_key: string;
		};
		expect(after.name_key).toBe(`${owner}${NAME_KEY_SEPARATOR}${store.name_key}`);
		// Public stores are untouched.
		expect(
			db.prepare('SELECT id, name_key FROM stores WHERE private_to IS NULL ORDER BY id').all()
		).toEqual(publicKeysBefore);
		db.close();
	});
});
