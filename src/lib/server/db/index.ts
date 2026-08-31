/**
 * SQLite connection — CONTRACT.md §1.1 pragmas and §1.1a binding rules.
 *
 * `node:sqlite` is synchronous and there is exactly one process, so the event
 * loop is the write serializer. The application uses ONE connection for reads
 * and writes; there is no pool. `busy_timeout` is defence in depth against a
 * second handle (a backup, a maintenance script, a test), not the design.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migrate } from './migrations.js';

export type Db = DatabaseSync;

export interface OpenOptions {
	/** Defaults to 5000 per §1.1. Lowered only by tests that must observe SQLITE_BUSY. */
	busyTimeout?: number;
	/** `NORMAL` per §1.1; `FULL` via ZEMBIL_SYNCHRONOUS. */
	synchronous?: 'NORMAL' | 'FULL';
	/** Run pending migrations on open. Defaults to true. */
	migrate?: boolean;
}

const SYNCHRONOUS_VALUES = new Set(['NORMAL', 'FULL']);

/**
 * Opens a connection and applies the §1.1 pragmas. Pragma values here are
 * literals from this module or values validated against a closed set — SQLite
 * does not accept bound parameters in a PRAGMA.
 */
export function openDatabase(filePath: string, options: OpenOptions = {}): Db {
	mkdirSync(dirname(filePath), { recursive: true });

	const db = new DatabaseSync(filePath);

	const busyTimeout = options.busyTimeout ?? 5000;
	if (!Number.isInteger(busyTimeout) || busyTimeout < 0 || busyTimeout > 600_000) {
		throw new Error(`Invalid busy_timeout: ${busyTimeout}`);
	}

	const synchronous = options.synchronous ?? (process.env.ZEMBIL_SYNCHRONOUS === 'FULL' ? 'FULL' : 'NORMAL');
	if (!SYNCHRONOUS_VALUES.has(synchronous)) {
		throw new Error(`Invalid ZEMBIL_SYNCHRONOUS: ${synchronous}`);
	}

	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
	db.exec(`PRAGMA synchronous = ${synchronous}`);
	db.exec('PRAGMA trusted_schema = OFF');
	db.exec('PRAGMA journal_size_limit = 67108864');
	db.exec('PRAGMA wal_autocheckpoint = 1000');
	db.exec('PRAGMA temp_store = MEMORY');

	if (options.migrate !== false) migrate(db);

	return db;
}

let instance: Db | null = null;

export function databaseFile(): string {
	const dir = process.env.ZEMBIL_DATA_DIR ?? '/data';
	return join(dir, 'zembil.db');
}

/** The application's single connection. Opened and migrated on first use. */
export function getDb(): Db {
	if (instance === null) instance = openDatabase(databaseFile());
	return instance;
}

/** Test seam: point `getDb()` at a specific handle. Not used by application code. */
export function setDb(db: Db | null): void {
	instance = db;
}

/**
 * `BEGIN IMMEDIATE … COMMIT`, with `ROLLBACK` on any throw. Every multi-statement
 * mutation in the domain layer goes through this.
 */
export function tx<T>(db: Db, fn: () => T): T {
	// BEGIN IMMEDIATE, never a deferred BEGIN: it takes the write lock up front,
	// so a read-then-write transaction (closeTrip's status re-read at R-6 step 1
	// followed by its UPDATE at step 3) can never lose its snapshot to a rival
	// that committed in between. Under a deferred BEGIN the loser of that race
	// gets SQLITE_BUSY_SNAPSHOT (errcode 517), which busy_timeout does NOT retry,
	// instead of R-11's mandated 409 TRIP_ALREADY_CLOSED.
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = fn();
		// COMMIT is inside the try: if it throws, the transaction is still open,
		// and this is the process's single connection.
		db.exec('COMMIT');
		return result;
	} finally {
		// A failing statement may already have unwound the transaction; a failing
		// COMMIT has not. Either way the connection must never be left inside one,
		// or every later tx() fails with "cannot start a transaction within a
		// transaction" until the process restarts.
		if (db.isTransaction) {
			try {
				db.exec('ROLLBACK');
			} catch (rollbackError) {
				// Nothing can recover this connection from here, and swallowing it
				// silently is how it would go unnoticed. Log and let the original
				// error propagate.
				console.error('[zembil] ROLLBACK failed; connection may be unusable', rollbackError);
			}
		}
	}
}

/** §1.1a: JavaScript booleans cannot be bound. Convert at the repository boundary. */
export function bool(value: boolean): 0 | 1 {
	return value ? 1 : 0;
}

/** The inverse, for reading INTEGER 0/1 columns back out. */
export function fromBool(value: unknown): boolean {
	return value === 1 || value === 1n || value === true;
}
