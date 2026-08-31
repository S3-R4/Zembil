/**
 * Password hashing — CONTRACT.md §1.3, D-005.
 *
 * `scrypt$N=65536,r=8,p=1$<salt-b64url>$<hash-b64url>`. Verification is
 * constant-time (`crypto.timingSafeEqual`); `===` on a derived key is a defect.
 * `maxmem` must be raised to 128 MiB or `crypto.scrypt` throws at N=65536, r=8.
 */
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

function scrypt(password: string, salt: Buffer, keylen: number, opts: Record<string, number>): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCallback(password, salt, keylen, opts, (err, derivedKey) => {
			if (err) reject(err);
			else resolve(derivedKey as Buffer);
		});
	});
}

export const SCRYPT_TARGET = Object.freeze({ N: 65536, r: 8, p: 1 });
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// §1.3: N=65536, r=8 needs ~64 MiB; raised further here for headroom.
const MAXMEM = 128 * 1024 * 1024;

const ENCODED_RE =
	/^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

interface ParsedHash {
	N: number;
	r: number;
	p: number;
	salt: Buffer;
	hash: Buffer;
}

function parse(encoded: string): ParsedHash | null {
	const m = ENCODED_RE.exec(encoded);
	if (!m) return null;
	const N = Number(m[1]);
	const r = Number(m[2]);
	const p = Number(m[3]);
	if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return null;
	return {
		N,
		r,
		p,
		salt: Buffer.from(m[4], 'base64url'),
		hash: Buffer.from(m[5], 'base64url')
	};
}

export async function hashPassword(
	password: string,
	target: { N: number; r: number; p: number } = SCRYPT_TARGET
): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const derived = await scrypt(password, salt, KEY_BYTES, { ...target, maxmem: MAXMEM });
	return `scrypt$N=${target.N},r=${target.r},p=${target.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/** Constant-time verification. Returns `false` for a malformed encoding rather than throwing. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	const parsed = parse(encoded);
	if (!parsed) return false;
	const derived = await scrypt(password, parsed.salt, parsed.hash.length, {
		N: parsed.N,
		r: parsed.r,
		p: parsed.p,
		maxmem: MAXMEM
	});
	if (derived.length !== parsed.hash.length) return false;
	return timingSafeEqual(derived, parsed.hash);
}

/** True when the stored hash's parameters are weaker than the current target (§1.3: transparent rehash). */
export function needsRehash(encoded: string, target: { N: number; r: number; p: number } = SCRYPT_TARGET): boolean {
	const parsed = parse(encoded);
	if (!parsed) return true;
	return (
		parsed.N !== target.N ||
		parsed.r !== target.r ||
		parsed.p !== target.p ||
		parsed.salt.length !== SALT_BYTES ||
		parsed.hash.length !== KEY_BYTES
	);
}

/**
 * The enumeration-resistance mechanism for login (§3.2): "On an unknown
 * username the server still performs a dummy scrypt verification against a
 * fixed hash so the timing does not differ." Computed once, lazily, from the
 * real `hashPassword` — reusing the exact function under test rather than a
 * hand-typed constant, so a change to the encoding can never desynchronize the
 * dummy path from the real one.
 */
let dummyHashPromise: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
	if (!dummyHashPromise) {
		dummyHashPromise = hashPassword('zembil-dummy-account-0000000000-never-issued');
	}
	return dummyHashPromise;
}

/** Same cost as `verifyPassword` against a real row; the result is discarded. */
export async function dummyVerify(password: string): Promise<void> {
	const hash = await getDummyHash();
	await verifyPassword(password, hash);
}

const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_PASSWORD_LENGTH = 20;

/** §3.3: a 20-character temporary password from an alphabet with no ambiguous glyphs. */
export function generateTemporaryPassword(): string {
	let out = '';
	for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
		out += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
	}
	return out;
}

/** §1.1: NFKC-normalized then lowercased. Used for both `username_key` and login lookup. */
export function usernameKey(raw: string): string {
	return raw.normalize('NFKC').toLowerCase();
}
