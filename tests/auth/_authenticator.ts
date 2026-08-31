/**
 * A software WebAuthn authenticator, for the passkey tests.
 *
 * PLAN.md §6 asks for "passkey register and login" as an M2 exit criterion, and
 * a test that stops at "the options object looks right" does not cover it. This
 * generates a real ES256 key pair, produces real signed attestation and
 * assertion responses, and hands them to the real `@simplewebauthn/server`
 * verification path — so the whole route, including the COSE key we stored and
 * the counter we wrote back, is exercised end to end.
 *
 * It is a test double for the DEVICE, not for any part of the application.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

// ---------------------------------------------------------------------------
// Just enough CBOR to build an attestation object. Encoding only.
// ---------------------------------------------------------------------------

function head(major: number, value: number): Buffer {
	const type = major << 5;
	if (value < 24) return Buffer.from([type | value]);
	if (value < 0x100) return Buffer.from([type | 24, value]);
	if (value < 0x10000) return Buffer.from([type | 25, value >> 8, value & 0xff]);
	return Buffer.from([type | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

const uint = (n: number) => head(0, n);
/** CBOR encodes a negative integer -1-n as major type 1 holding n. */
const negative = (n: number) => head(1, -1 - n);
const bytes = (b: Uint8Array) => Buffer.concat([head(2, b.length), Buffer.from(b)]);
const text = (s: string) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const map = (entries: Array<[Buffer, Buffer]>) =>
	Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [k, v])]);

/** COSE_Key for ES256: {1:2 (EC2), 3:-7 (ES256), -1:1 (P-256), -2:x, -3:y}. */
function coseKey(publicKey: KeyObject): Buffer {
	const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
	return map([
		[uint(1), uint(2)],
		[uint(3), negative(-7)],
		[negative(-1), uint(1)],
		[negative(-2), bytes(Buffer.from(jwk.x, 'base64url'))],
		[negative(-3), bytes(Buffer.from(jwk.y, 'base64url'))]
	]);
}

// ---------------------------------------------------------------------------

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function counterBytes(counter: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(counter >>> 0, 0);
	return b;
}

export interface SoftAuthenticatorOptions {
	rpId: string;
	origin: string;
	/** Some authenticators report a real counter, most platform ones report 0. */
	counter?: number;
}

export class SoftAuthenticator {
	readonly rpId: string;
	readonly origin: string;
	readonly credentialId: Buffer;
	counter: number;
	private readonly privateKey: KeyObject;
	private readonly publicKey: KeyObject;

	constructor(options: SoftAuthenticatorOptions) {
		this.rpId = options.rpId;
		this.origin = options.origin;
		this.counter = options.counter ?? 0;
		const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		this.privateKey = pair.privateKey;
		this.publicKey = pair.publicKey;
		this.credentialId = Buffer.from(
			Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 13) % 251)
		);
		// Distinct per instance, so two authenticators in one test do not collide.
		this.credentialId[0] = Math.floor(Math.random() * 256);
		this.credentialId[1] = Math.floor(Math.random() * 256);
	}

	private rpIdHash(rpId = this.rpId): Buffer {
		return createHash('sha256').update(rpId, 'utf8').digest();
	}

	private clientData(type: string, challenge: string, origin = this.origin): Buffer {
		return Buffer.from(
			JSON.stringify({ type, challenge, origin, crossOrigin: false }),
			'utf8'
		);
	}

	/** A `RegistrationResponseJSON`, as `startRegistration()` would return. */
	register(
		challenge: string,
		overrides: { rpId?: string; origin?: string; flags?: number } = {}
	) {
		const clientDataJSON = this.clientData('webauthn.create', challenge, overrides.origin);
		const authData = Buffer.concat([
			this.rpIdHash(overrides.rpId),
			Buffer.from([overrides.flags ?? FLAG_UP | FLAG_UV | FLAG_AT]),
			counterBytes(this.counter),
			Buffer.alloc(16), // AAGUID — all zeroes, as platform authenticators report
			Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]),
			this.credentialId,
			coseKey(this.publicKey)
		]);
		const attestationObject = map([
			[text('fmt'), text('none')],
			[text('attStmt'), map([])],
			[text('authData'), bytes(authData)]
		]);

		return {
			id: b64url(this.credentialId),
			rawId: b64url(this.credentialId),
			response: {
				clientDataJSON: b64url(clientDataJSON),
				attestationObject: b64url(attestationObject),
				transports: ['internal', 'hybrid']
			},
			type: 'public-key',
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}

	/** An `AuthenticationResponseJSON`, as `startAuthentication()` would return. */
	authenticate(
		challenge: string,
		userHandle: Uint8Array,
		overrides: { counter?: number; origin?: string; rpId?: string; tamper?: boolean } = {}
	) {
		const counter = overrides.counter ?? this.counter;
		const clientDataJSON = this.clientData('webauthn.get', challenge, overrides.origin);
		const authenticatorData = Buffer.concat([
			this.rpIdHash(overrides.rpId),
			Buffer.from([FLAG_UP | FLAG_UV]),
			counterBytes(counter)
		]);
		const signed = Buffer.concat([
			authenticatorData,
			createHash('sha256').update(clientDataJSON).digest()
		]);
		const signature = sign('sha256', signed, this.privateKey);
		if (overrides.tamper) signature[signature.length - 1] ^= 0xff;

		return {
			id: b64url(this.credentialId),
			rawId: b64url(this.credentialId),
			response: {
				clientDataJSON: b64url(clientDataJSON),
				authenticatorData: b64url(authenticatorData),
				signature: b64url(signature),
				userHandle: b64url(userHandle)
			},
			type: 'public-key',
			clientExtensionResults: {},
			authenticatorAttachment: 'platform'
		};
	}
}
