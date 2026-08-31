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
	db.exec('BEGIN IMMEDIATE');
	let result: T;
	try {
		result = fn();
	} catch (err) {
		try {
			db.exec('ROLLBACK');
		} catch {
			/* the failing statement may already have unwound the transaction */
		}
		throw err;
	}
	db.exec('COMMIT');
	return result;
}

/** §1.1a: JavaScript booleans cannot be bound. Convert at the repository boundary. */
export function bool(value: boolean): 0 | 1 {
	return value ? 1 : 0;
}

/** The inverse, for reading INTEGER 0/1 columns back out. */
export function fromBool(value: unknown): boolean {
	return value === 1 || value === 1n || value === true;
}
