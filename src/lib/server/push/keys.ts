/**
 * The VAPID keypair — CONTRACT.md §8.7, D-038.
 *
 * This is the first secret the application has ever held, and PROJECT.md §7
 * says flatly "there is no application secret". That sentence needs one word of
 * qualification, not a rewrite: the property that mattered was never "no bytes
 * on disk are sensitive", it was **nothing for an operator to create, rotate or
 * leak into a compose file**. That property still holds exactly. The keypair is
 * GENERATED here on first use and stored in `server_keys`, so there is no
 * environment variable, no mounted key file, and no line in `.env.example` for
 * someone to paste into a chat window. It lives in the database because the
 * database is the one artefact the deployment already backs up and already
 * treats as the durable, private volume (D-013).
 *
 * What the private key protects is narrow, and worth stating so nobody
 * over-rotates it in a panic: it authenticates *us* to a push service. It does
 * not encrypt list contents (that is the subscription's own `p256dh`/`auth`,
 * which belong to the browser), and it grants no access to Zembil. An attacker
 * holding it AND a stolen `push_subscriptions` row could send a family member a
 * fake notification. Losing it — deleting the row — costs nothing but a
 * re-subscribe on every device.
 *
 * **The private key never leaves this module's return value.** No endpoint
 * returns it, no log line prints it, and no error message includes it; the only
 * consumer is `deliver.ts`, which hands it to `web-push` and nothing else. A
 * test in `tests/push/` asserts that no response body from any `/api/push/*`
 * route contains it.
 */
import webpush from 'web-push';
import type { Db } from '../db/index.js';
import { tx } from '../db/index.js';

export interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

/**
 * Cached per connection rather than globally. In production there is exactly
 * one connection for the life of the process, so this is a plain memo; keying
 * it on the handle is what keeps a test suite that opens a fresh database file
 * from being served the previous suite's keypair.
 */
let cache: { db: Db; keys: VapidKeys } | null = null;

interface KeyRow {
	public_key: string;
	private_key: string;
}

function read(db: Db): VapidKeys | null {
	const row = db
		.prepare(`SELECT public_key, private_key FROM server_keys WHERE name = 'vapid'`)
		.get() as unknown as KeyRow | undefined;
	if (!row) return null;
	return { publicKey: row.public_key, privateKey: row.private_key };
}

/**
 * Get-or-create. Idempotent: the INSERT is `ON CONFLICT DO NOTHING` inside a
 * `BEGIN IMMEDIATE` transaction and the value returned is always the one that
 * is *in the table* afterwards, never the one this call happened to generate.
 *
 * `node:sqlite` is synchronous and there is one process, so two callers cannot
 * actually interleave here — but "cannot interleave" is a property of today's
 * runtime, and a second keypair would silently invalidate every subscription
 * registered against the first. The conflict clause costs nothing and does not
 * depend on that property holding.
 */
export function getVapidKeys(db: Db): VapidKeys {
	if (cache && cache.db === db) return cache.keys;

	const existing = read(db);
	if (existing) {
		cache = { db, keys: existing };
		return existing;
	}

	const keys = tx(db, () => {
		// Re-read inside the write lock: another caller may have created the row
		// between the read above and BEGIN IMMEDIATE.
		const inside = read(db);
		if (inside) return inside;

		const generated = webpush.generateVAPIDKeys();
		db.prepare(
			`INSERT INTO server_keys (name, public_key, private_key, created_at)
			 VALUES ('vapid', ?, ?, ?)
			 ON CONFLICT (name) DO NOTHING`
		).run(generated.publicKey, generated.privateKey, Date.now());

		// Read back rather than returning `generated`: if the conflict clause
		// fired, the row is somebody else's keypair and that is the one every
		// browser will have subscribed against.
		const stored = read(db);
		if (!stored) throw new Error('VAPID key row vanished immediately after insert.');
		return stored;
	});

	cache = { db, keys };
	return keys;
}

/** The only half that may cross the network. */
export function getVapidPublicKey(db: Db): string {
	return getVapidKeys(db).publicKey;
}

/** Test seam, mirroring `setDb(null)` and `resetConfig()`. */
export function resetVapidKeyCache(): void {
	cache = null;
}
