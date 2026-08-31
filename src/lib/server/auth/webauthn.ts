/**
 * WebAuthn / passkeys — CONTRACT.md §3.2, §1.1 (`credentials`,
 * `webauthn_challenges`), D-029.
 *
 * Built against `@simplewebauthn/server` v13.3.3 signatures read out of the
 * shipped `.d.ts` files, not from recall (D-029). The v13 shapes that differ
 * from earlier majors and from the library's own stale JSDoc:
 *   - `verifyRegistrationResponse` returns `registrationInfo.credential`
 *     (`{ id, publicKey, counter, transports? }`) — NOT flat `credentialID` /
 *     `credentialPublicKey`.
 *   - `verifyAuthenticationResponse` takes `credential:`, not `authenticator:`,
 *     and `expectedRPID` is required.
 */
import { randomUUID } from 'node:crypto';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse
} from '@simplewebauthn/server';
import type {
	AuthenticationResponseJSON,
	AuthenticatorTransportFuture,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/server';
import { bool, type Db } from '../db/index.js';
import { DomainError } from '../domain/errors.js';
import { requiredText } from '../domain/validate.js';
import { getConfig } from './config.js';
import { type UserRow } from './users.js';

/** Long enough for a slow OS prompt, short enough that a stale row is useless. */
export const CHALLENGE_TTL_MS = 5 * 60_000;

export type ChallengePurpose = 'registration' | 'authentication';

/** §3.2: verification failures are ALL `401 INVALID_CREDENTIALS`, with one
 *  message — an unknown credential must not be distinguishable from a bad
 *  signature, an expired challenge, or a disabled account. */
export function invalidCredentials(): DomainError {
	return new DomainError('INVALID_CREDENTIALS', 401, 'Those sign-in details are not valid.');
}

/** §3.7: the reaper bounds disk; expiry is enforced on read regardless. */
export function reapExpiredChallenges(db: Db, now = Date.now()): number {
	const result = db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(now);
	return Number(result.changes);
}

function storeChallenge(
	db: Db,
	challenge: string,
	userId: string | null,
	purpose: ChallengePurpose
): string {
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		`INSERT INTO webauthn_challenges (id, challenge, user_id, purpose, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(id, challenge, userId, purpose, now, now + CHALLENGE_TTL_MS);
	return id;
}

interface ChallengeRow {
	id: string;
	challenge: string;
	user_id: string | null;
	purpose: string;
	expires_at: number;
}

/**
 * §3.2: "The challenge row is deleted on FIRST use, success or failure."
 *
 * So the DELETE happens here, before verification is even attempted, and the
 * expiry is checked on the row this call just removed. A row deleted only on
 * the success path would let an attacker replay one challenge until a signature
 * happened to verify.
 */
export function consumeChallenge(
	db: Db,
	challengeId: unknown,
	purpose: ChallengePurpose,
	now = Date.now()
): { challenge: string; userId: string | null } {
	if (typeof challengeId !== 'string' || challengeId.length === 0) throw invalidCredentials();
	const row = db
		.prepare(
			'SELECT id, challenge, user_id, purpose, expires_at FROM webauthn_challenges WHERE id = ?'
		)
		.get(challengeId) as unknown as ChallengeRow | undefined;
	if (!row) throw invalidCredentials();
	db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(challengeId);
	if (row.purpose !== purpose) throw invalidCredentials();
	if (Number(row.expires_at) <= now) throw invalidCredentials();
	return { challenge: row.challenge, userId: row.user_id };
}

// --------------------------------------------------------------------------
// Credentials
// --------------------------------------------------------------------------

export interface CredentialRecord {
	id: string;
	userId: string;
	/** `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: the library's
	 *  `Uint8Array_` alias pins the buffer type, and a `SharedArrayBuffer`-backed
	 *  view would not satisfy it. `node:sqlite` always hands back the plain kind. */
	publicKey: Uint8Array<ArrayBuffer>;
	counter: number;
	transports: AuthenticatorTransportFuture[] | undefined;
}

interface CredentialDbRow {
	id: string;
	user_id: string;
	public_key: Uint8Array<ArrayBuffer>;
	counter: number;
	transports: string | null;
}

function parseTransports(raw: string | null): AuthenticatorTransportFuture[] | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return undefined;
		return parsed.filter((t): t is AuthenticatorTransportFuture => typeof t === 'string');
	} catch {
		// A row we wrote ourselves; if it is somehow unreadable, transports are a
		// UX hint and losing them must not break the assertion.
		return undefined;
	}
}

export function findCredential(db: Db, credentialId: string): CredentialRecord | null {
	const row = db
		.prepare('SELECT id, user_id, public_key, counter, transports FROM credentials WHERE id = ?')
		.get(credentialId) as unknown as CredentialDbRow | undefined;
	if (!row) return null;
	return {
		id: row.id,
		userId: row.user_id,
		publicKey: row.public_key,
		counter: Number(row.counter),
		transports: parseTransports(row.transports)
	};
}

function credentialsOf(db: Db, userId: string): CredentialDbRow[] {
	return db
		.prepare(
			'SELECT id, user_id, public_key, counter, transports FROM credentials WHERE user_id = ?'
		)
		.all(userId) as unknown as CredentialDbRow[];
}

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

export interface OptionsResult<T> {
	options: T;
	challengeId: string;
}

export async function beginRegistration(
	db: Db,
	user: UserRow,
	userHandle: Uint8Array<ArrayBuffer>
): Promise<OptionsResult<PublicKeyCredentialCreationOptionsJSON>> {
	const config = getConfig();
	reapExpiredChallenges(db);
	const existing = credentialsOf(db, user.id);

	const options = await generateRegistrationOptions({
		rpName: config.rpName,
		rpID: config.rpId,
		// §3.2: the account's `webauthn_user_handle` — never the username, never
		// a sequential integer. A username here would be handed to every
		// authenticator the member ever registers with.
		userID: userHandle,
		userName: user.username,
		userDisplayName: user.display_name,
		attestationType: 'none',
		excludeCredentials: existing.map((row) => ({
			id: row.id,
			transports: parseTransports(row.transports)
		})),
		// §3.2 / D-029: PINNED, never the library's defaults. v13 defaults
		// `residentKey` to 'preferred', under which an authenticator may create a
		// NON-discoverable credential: registration succeeds, the account screen
		// lists the passkey, and usernameless login — which sends an empty
		// `allowCredentials` by design — can never find it. 'required' turns that
		// silent dead end into a visible refusal at registration time.
		authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
		timeout: CHALLENGE_TTL_MS
	});

	const challengeId = storeChallenge(db, options.challenge, user.id, 'registration');
	return { options, challengeId };
}

export interface RegisteredCredential {
	id: string;
	publicKey: Uint8Array<ArrayBuffer>;
	counter: number;
	transports: string | null;
	backedUp: boolean;
}

export async function verifyRegistration(
	response: unknown,
	expectedChallenge: string
): Promise<RegisteredCredential> {
	const config = getConfig();
	let verification;
	try {
		verification = await verifyRegistrationResponse({
			response: response as RegistrationResponseJSON,
			expectedChallenge,
			expectedOrigin: config.origin,
			expectedRPID: config.rpId,
			// §3.2 pins `userVerification: 'preferred'` on the options, so requiring
			// it at verification time would reject the authenticators that option
			// deliberately admits.
			requireUserVerification: false
		});
	} catch (err) {
		// The library throws on a malformed or mismatched response. Detail goes to
		// the log; the caller gets the one indistinguishable failure.
		console.error('[zembil] passkey registration verification failed', err);
		throw invalidCredentials();
	}

	// D-029: the JSDoc above this type still documents the flat v9 shape while
	// the type returns a nested `credential`. Reading the comment rather than
	// the type produces code that compiles and fails at runtime.
	const info = verification.registrationInfo;
	// `verified` is redundant against `info` on v13 — the library throws rather
	// than returning `{verified:false}` with a `registrationInfo` — so no test can
	// tell the two halves apart. Both are checked because that is an
	// implementation detail of the library, not a guarantee of its API.
	if (!verification.verified || !info) throw invalidCredentials();

	return {
		id: info.credential.id,
		publicKey: info.credential.publicKey as Uint8Array<ArrayBuffer>,
		counter: Number(info.credential.counter ?? 0),
		transports: info.credential.transports ? JSON.stringify(info.credential.transports) : null,
		backedUp: Boolean(info.credentialBackedUp)
	};
}

export const passkeyLabel = (value: unknown) => requiredText(value, 'Label', 64);

export function insertCredential(
	db: Db,
	userId: string,
	credential: RegisteredCredential,
	label: string
): void {
	db.prepare(
		`INSERT INTO credentials (id, user_id, public_key, counter, transports, device_label,
		                          backed_up, created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
	).run(
		credential.id,
		userId,
		credential.publicKey,
		credential.counter,
		credential.transports,
		label,
		bool(credential.backedUp),
		Date.now()
	);
}

// --------------------------------------------------------------------------
// Authentication
// --------------------------------------------------------------------------

export async function beginAuthentication(
	db: Db
): Promise<OptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
	const config = getConfig();
	reapExpiredChallenges(db);
	const options = await generateAuthenticationOptions({
		rpID: config.rpId,
		// §3.2: EMPTY by design. Discoverable credentials mean the response is
		// identical regardless of who exists, which is what makes this flow
		// enumeration-safe. Populating it from a username would undo that.
		allowCredentials: [],
		userVerification: 'preferred',
		timeout: CHALLENGE_TTL_MS
	});
	const challengeId = storeChallenge(db, options.challenge, null, 'authentication');
	return { options, challengeId };
}

export interface AssertionResult {
	credentialId: string;
	userId: string;
	newCounter: number;
}

export async function verifyAssertion(
	db: Db,
	response: unknown,
	expectedChallenge: string
): Promise<AssertionResult> {
	const config = getConfig();
	const raw = response as AuthenticationResponseJSON | null;
	if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') throw invalidCredentials();

	const stored = findCredential(db, raw.id);
	if (!stored) throw invalidCredentials();

	let verification;
	try {
		verification = await verifyAuthenticationResponse({
			response: raw,
			expectedChallenge,
			expectedOrigin: config.origin,
			expectedRPID: config.rpId,
			// v13: `credential:`, not `authenticator:` (D-029).
			credential: {
				id: stored.id,
				publicKey: stored.publicKey,
				counter: stored.counter,
				transports: stored.transports
			},
			requireUserVerification: false
		});
	} catch (err) {
		// This is also where the clone check surfaces. The library applies exactly
		// the rule §3.2 states — it throws only when
		// `(returned > 0 || stored > 0) && returned <= stored`, so a
		// permanently-zero counter, which most platform authenticators report, is
		// accepted rather than rejected.
		console.error('[zembil] passkey assertion verification failed', err);
		throw invalidCredentials();
	}

	if (!verification.verified) throw invalidCredentials();

	return {
		credentialId: stored.id,
		userId: stored.userId,
		newCounter: Number(verification.authenticationInfo.newCounter)
	};
}

/**
 * §3.2: "A successful assertion writes back." Without this the clone check
 * compares every future assertion against a permanently-zero stored value and
 * can never fire, and `Passkey.lastUsedAt` stays null forever.
 */
export function recordAssertion(db: Db, credentialId: string, newCounter: number): void {
	db.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(
		newCounter,
		Date.now(),
		credentialId
	);
}
