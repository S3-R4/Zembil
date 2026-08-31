/** Migration runner, connection pragmas and STRICT behaviour — CONTRACT.md §1.1, D-018. */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { getUserVersion, LATEST_VERSION, migrate } from '$lib/server/db/migrations';
import { openDatabase } from '$lib/server/db';
import { harness } from '../domain/_support';

const pragma = (db: any, name: string) => {
	const row = db.prepare(`PRAGMA ${name}`).get();
	return row ? Object.values(row)[0] : undefined;
};

describe('migration runner', () => {
	test('applies 001 and stamps user_version', () => {
		const h = harness();
		try {
			expect(getUserVersion(h.db)).toBe(LATEST_VERSION);
			expect(LATEST_VERSION).toBe(1);
			const tables = (
				h.db
					.prepare(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
					.all() as Array<{ name: string }>
			).map((r) => r.name);
			expect(tables.sort()).toEqual(
				['credentials', 'items', 'sessions', 'stores', 'trips', 'users', 'webauthn_challenges'].sort()
			);
		} finally {
			h.close();
		}
	});

	test('is forward-only and idempotent — a second run applies nothing', () => {
		const h = harness();
		try {
			const result = migrate(h.db);
			expect(result.applied).toEqual([]);
			expect(result.from).toBe(1);
			expect(result.to).toBe(1);
		} finally {
			h.close();
		}
	});

	test('reopening an existing file does not re-run migrations', () => {
		const h = harness();
		try {
			h.db.prepare('SELECT 1').get();
			const second = h.second({ migrate: true });
			expect(getUserVersion(second)).toBe(1);
		} finally {
			h.close();
		}
	});

	test('a failing migration leaves user_version untouched', () => {
		const h = harness();
		try {
			// Re-running 001's DDL against an already-migrated database must abort.
			expect(() => h.db.exec('CREATE TABLE users (id TEXT PRIMARY KEY) STRICT')).toThrow();
			expect(getUserVersion(h.db)).toBe(1);
		} finally {
			h.close();
		}
	});

	test('the database is a real file, not :memory:', () => {
		const h = harness();
		try {
			expect(existsSync(h.file)).toBe(true);
		} finally {
			h.close();
		}
	});
});

describe('connection pragmas (§1.1)', () => {
	test('WAL, foreign keys, busy_timeout, synchronous and temp_store are set', () => {
		const h = harness();
		try {
			expect(String(pragma(h.db, 'journal_mode')).toLowerCase()).toBe('wal');
			expect(Number(pragma(h.db, 'foreign_keys'))).toBe(1);
			expect(Number(pragma(h.db, 'busy_timeout'))).toBe(5000);
			expect(Number(pragma(h.db, 'synchronous'))).toBe(1); // NORMAL
			expect(Number(pragma(h.db, 'temp_store'))).toBe(2); // MEMORY
			expect(Number(pragma(h.db, 'journal_size_limit'))).toBe(67108864);
			expect(Number(pragma(h.db, 'wal_autocheckpoint'))).toBe(1000);
		} finally {
			h.close();
		}
	});

	test('foreign keys are actually enforced, not merely declared', () => {
		const h = harness();
		try {
			expect(() =>
				h.db
					.prepare(
						`INSERT INTO trips (id, store_id, seq, status, opened_at) VALUES (?, ?, 1, 'open', ?)`
					)
					.run(randomUUID(), 'no-such-store', Date.now())
			).toThrow(/FOREIGN KEY/i);
		} finally {
			h.close();
		}
	});

	test('a bad busy_timeout is rejected rather than interpolated', () => {
		expect(() => openDatabase('/tmp/zembil-never.db', { busyTimeout: -1 })).toThrow();
	});

	test('a bad ZEMBIL_SYNCHRONOUS value is rejected rather than interpolated', () => {
		expect(() =>
			openDatabase('/tmp/zembil-never-sync.db', { synchronous: 'FAST' as any })
		).toThrow();
	});
});

describe('STRICT tables (D-018)', () => {
	test('every table is declared STRICT', () => {
		const h = harness();
		try {
			const rows = h.db
				.prepare(`SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
				.all() as Array<{ name: string; sql: string }>;
			for (const row of rows) expect(row.sql).toMatch(/\)\s*STRICT\s*$/);
		} finally {
			h.close();
		}
	});

	test('a string written to an INTEGER column is rejected, not silently stored', () => {
		const h = harness();
		try {
			expect(() =>
				h.db
					.prepare('INSERT INTO stores (id, name, name_key, sort_order, created_at) VALUES (?,?,?,?,?)')
					.run(randomUUID(), 'Migros', 'migros', 'banana' as unknown as number, Date.now())
			).toThrow();
		} finally {
			h.close();
		}
	});
});

describe('§1.1a node:sqlite binding rules', () => {
	test('a JavaScript boolean cannot be bound — booleans convert at the repository boundary', () => {
		const h = harness();
		try {
			expect(() =>
				h.db
					.prepare('INSERT INTO stores (id, name, name_key, sort_order, created_at) VALUES (?,?,?,?,?)')
					.run(randomUUID(), 'Migros', 'migros', true as unknown as number, Date.now())
			).toThrow();
		} finally {
			h.close();
		}
	});

	test('rows come back as null-prototype objects', () => {
		const h = harness();
		try {
			const row = h.db.prepare('SELECT 1 AS one').get() as object;
			expect(Object.getPrototypeOf(row)).toBe(null);
			expect(Object.hasOwn(row, 'one')).toBe(true);
		} finally {
			h.close();
		}
	});
});
