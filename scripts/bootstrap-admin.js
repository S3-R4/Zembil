#!/usr/bin/env node
/**
 * scripts/bootstrap-admin.js — CONTRACT.md §3.8.
 *
 * The recovery path for an operator who has locked themselves out. It is NEVER
 * part of normal startup: the app bootstraps its first admin in-process
 * (`src/hooks.server.ts`), because the brief requires it to come up with a
 * single `docker compose up`.
 *
 * Run against a STOPPED container, or at least accept that the running process
 * holds the same file — SQLite's WAL mode makes concurrent access safe, and
 * `busy_timeout` covers the rest, but a reset while the owner is signed in is
 * confusing rather than dangerous.
 *
 *   docker compose run --rm --entrypoint node zembil scripts/bootstrap-admin.js --username ayse
 *
 * Plain JavaScript on purpose: it must run from the shipped image with no build
 * step and no TypeScript loader. That means the §1.3 hash encoding is written
 * twice — here and in `src/lib/server/auth/password.ts` — so
 * `tests/auth/bootstrap-script.test.ts` asserts that a hash produced here
 * verifies under the application's own `verifyPassword`. Drift fails the suite.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, randomUUID, scrypt } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** @type {(password: string, salt: Buffer, keylen: number, opts: Record<string, number>) => Promise<Buffer>} */
const scryptAsync = /** @type {any} */ (promisify(scrypt));

export const SCRYPT_TARGET = { N: 65536, r: 8, p: 1 };
const MAXMEM = 128 * 1024 * 1024;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** @param {number} [length] */
export function generatePassword(length = 20) {
	let out = '';
	for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
	return out;
}

/** §1.3: `scrypt$N=…,r=…,p=…$<salt-b64url>$<key-b64url>`. */
/** @param {string} password */
export async function hashPassword(password) {
	const salt = randomBytes(16);
	const derived = await scryptAsync(password, salt, 32, { ...SCRYPT_TARGET, maxmem: MAXMEM });
	return (
		`scrypt$N=${SCRYPT_TARGET.N},r=${SCRYPT_TARGET.r},p=${SCRYPT_TARGET.p}$` +
		`${salt.toString('base64url')}$${derived.toString('base64url')}`
	);
}

/** §1.1: NFKC then lowercase. Must match `usernameKey` in password.ts exactly. */
/** @param {string} raw */
export function usernameKey(raw) {
	return raw.normalize('NFKC').toLowerCase();
}

/**
 * @param {string[]} argv
 * @returns {{ username: string, password: string | null, dataDir: string, help?: boolean }}
 */
export function parseArgs(argv) {
	/** @type {{ username: string, password: string | null, dataDir: string, help?: boolean }} */
	const args = { username: 'admin', password: null, dataDir: process.env.ZEMBIL_DATA_DIR ?? '/data' };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--username' || arg === '-u') args.username = argv[++i];
		else if (arg === '--password' || arg === '-p') args.password = argv[++i];
		else if (arg === '--data-dir') args.dataDir = argv[++i];
		else if (arg === '--help' || arg === '-h') args.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!args.username || args.username.trim().length === 0) {
		throw new Error('--username cannot be empty.');
	}
	if (args.password !== null && args.password.length < 12) {
		throw new Error('--password must be at least 12 characters (CONTRACT.md §3.2).');
	}
	return args;
}

const USAGE = `Usage: node scripts/bootstrap-admin.js [--username NAME] [--password PASS] [--data-dir DIR]

Creates the named account as an active admin, or — if it already exists —
re-enables it, grants admin, and resets its password. The password is printed
once and is never stored in plaintext. The account is flagged so it must be
changed at next sign-in.`;

/**
 * Exported for the test. Takes an open database rather than a path so the test
 * can run it against a temporary file with the real migrations applied.
 */
/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username
 * @param {string} password
 */
export async function bootstrapAdmin(db, username, password) {
	const key = usernameKey(username);
	const hash = await hashPassword(password);
	const ts = Date.now();
	const existing = db.prepare('SELECT id FROM users WHERE username_key = ?').get(key);

	db.exec('BEGIN IMMEDIATE');
	try {
		if (existing) {
			// One statement for is_active and disabled_at: the DDL's
			// `CHECK ((is_active = 0) = (disabled_at IS NOT NULL))` aborts otherwise.
			db.prepare(
				`UPDATE users
				    SET password_hash = ?, is_admin = 1, is_active = 1, disabled_at = NULL,
				        must_change_password = 1, updated_at = ?
				  WHERE id = ?`
			).run(hash, ts, existing.id);
		} else {
			db.prepare(
				`INSERT INTO users (id, username, username_key, display_name, password_hash,
				                    is_admin, is_active, must_change_password, webauthn_user_handle,
				                    created_at, updated_at, disabled_at)
				 VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, NULL)`
			).run(randomUUID(), username, key, username, hash, randomBytes(32), ts, ts);
		}
		db.exec('COMMIT');
	} finally {
		if (db.isTransaction) db.exec('ROLLBACK');
	}
	return { created: !existing };
}

async function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		console.error(`\n${USAGE}`);
		process.exit(2);
	}
	if (args.help) {
		console.log(USAGE);
		return;
	}

	const file = join(args.dataDir, 'zembil.db');
	const db = new DatabaseSync(file);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec('PRAGMA busy_timeout = 5000');

	const version = /** @type {{ user_version: number } | undefined} */ (
		/** @type {unknown} */ (db.prepare('PRAGMA user_version').get())
	);
	if (!version || Number(version.user_version) < 1) {
		// The app owns migrations. Creating the schema here would give the file two
		// authors and let this script write a shape the migration runner has never
		// seen.
		console.error(
			`No Zembil schema in ${file}. Start the app once so it runs its migrations, then re-run this.`
		);
		process.exit(1);
	}

	const password = args.password ?? generatePassword();
	const { created } = await bootstrapAdmin(db, args.username, password);
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	db.close();

	console.log(
		`\n  ${created ? 'Created' : 'Reset'} admin account "${args.username}".\n` +
			`      password: ${password}\n` +
			'      Shown once. It must be changed at next sign-in.\n'
	);
}

// Only when executed directly, so the test can import the functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
