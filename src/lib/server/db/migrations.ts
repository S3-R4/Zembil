/**
 * Forward-only numbered migrations, applied in a transaction, gated on
 * `PRAGMA user_version` — CONTRACT.md §1.1, D-003, D-018.
 *
 * A migration that has shipped is immutable. Corrections are new migrations.
 * There are no down-scripts: the rollback is the pre-migration snapshot (D-013).
 */
import type { DatabaseSync } from 'node:sqlite';
import migration001 from './migrations/001_initial.sql?raw';

export interface Migration {
	/** Target `user_version` after this migration applies. 1-based, contiguous. */
	version: number;
	name: string;
	sql: string;
}

/** Ordered, contiguous from 1. Append only. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
	{ version: 1, name: '001_initial', sql: migration001 }
]);

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export function getUserVersion(db: DatabaseSync): number {
	const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
	return row ? Number(row.user_version) : 0;
}

/**
 * Applies every migration whose version is greater than the database's current
 * `user_version`, each inside its own transaction, then stamps the version.
 *
 * `user_version` cannot be a bound parameter — SQLite pragmas do not accept
 * them. The value is therefore taken from the frozen MIGRATIONS table above and
 * re-validated as a safe non-negative integer before it is formatted in, which
 * is the one place in this codebase where SQL text is composed at all.
 */
export function migrate(db: DatabaseSync): { from: number; to: number; applied: string[] } {
	const from = getUserVersion(db);
	const applied: string[] = [];

	const pending = MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version);

	// Contiguity check: refuse to run a set with a hole in it.
	let expected = from + 1;
	for (const m of pending) {
		if (m.version !== expected) {
			throw new Error(
				`Migration sequence is not contiguous: expected ${expected}, found ${m.version}`
			);
		}
		expected += 1;
	}

	for (const m of pending) {
		if (!Number.isInteger(m.version) || m.version < 1 || m.version > 1_000_000) {
			throw new Error(`Refusing to stamp an implausible user_version: ${m.version}`);
		}
		db.exec('BEGIN IMMEDIATE');
		try {
			db.exec(m.sql);
			db.exec(`PRAGMA user_version = ${m.version}`);
			db.exec('COMMIT');
		} catch (err) {
			try {
				db.exec('ROLLBACK');
			} catch {
				/* the failed statement may already have unwound the transaction */
			}
			throw err;
		}
		applied.push(m.name);
	}

	return { from, to: getUserVersion(db), applied };
}
