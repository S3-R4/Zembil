/**
 * Environment configuration — CONTRACT.md §6.
 *
 * A single place that reads `process.env`, validates it, and fails loudly.
 * `hooks.server.ts` calls `getConfig()` at module load so a bad configuration
 * crashes the process before it starts listening (§6, "a migration that fails
 * must crash the process" — the same standard applies to configuration).
 */

export interface AuthConfig {
	/** Normalized (`new URL(...).origin`), e.g. `https://zembil.example.com`. */
	origin: string;
	originIsHttps: boolean;
	/** WebAuthn relying-party id — full hostname of `origin` unless overridden. */
	rpId: string;
	rpName: string;
	/** Trusted `X-Forwarded-For` hop count. `0` disables header trust entirely. */
	trustProxy: number;
	bootstrapUsername: string;
	bootstrapPassword: string | null;
	sessionIdleDays: number;
	sessionAbsoluteDays: number;
	logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function parseIntEnv(
	env: NodeJS.ProcessEnv,
	name: string,
	def: number,
	opts: { min?: number; max?: number } = {}
): number {
	const raw = env[name];
	if (raw === undefined || raw === '') return def;
	const n = Number(raw);
	// §3.1b / D-030: `Number.isSafeInteger`, never `Number.isInteger` — the latter
	// admits `1e300` and `9007199254740993`. Every caller below passes a max small
	// enough to reject both anyway, so no test can currently tell the two
	// predicates apart; this is the correct predicate for a caller that one day
	// omits the bound, not a guard that is load-bearing today.
	if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer, got: ${raw}`);
	if (opts.min !== undefined && n < opts.min) {
		throw new Error(`${name} must be >= ${opts.min}, got: ${n}`);
	}
	if (opts.max !== undefined && n > opts.max) {
		throw new Error(`${name} must be <= ${opts.max}, got: ${n}`);
	}
	return n;
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * Pure and testable: takes an env map rather than reading `process.env`
 * directly, so tests can construct a config without mutating the real
 * process environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
	const originRaw = env.ZEMBIL_ORIGIN;
	if (!originRaw) {
		throw new Error('ZEMBIL_ORIGIN is required (e.g. https://zembil.example.com).');
	}
	let url: URL;
	try {
		url = new URL(originRaw);
	} catch {
		throw new Error(`ZEMBIL_ORIGIN is not a valid URL: ${originRaw}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`ZEMBIL_ORIGIN must be http or https: ${originRaw}`);
	}
	if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
		throw new Error(`ZEMBIL_ORIGIN must be an origin with no path, query or fragment: ${originRaw}`);
	}

	const origin = url.origin;
	const originIsHttps = url.protocol === 'https:';
	const hostname = url.hostname;

	const rpIdRaw = env.ZEMBIL_RP_ID?.trim();
	const rpId = rpIdRaw || hostname;
	if (rpId !== hostname) {
		const isSuffix = hostname === rpId || hostname.endsWith(`.${rpId}`);
		if (!isSuffix) {
			throw new Error(
				`ZEMBIL_RP_ID (${rpId}) must be exactly the hostname of ZEMBIL_ORIGIN (${hostname}) or a suffix of it.`
			);
		}
		// §6 / D-022: a proper suffix widens passkey scope to every sibling
		// subdomain and is effectively irreversible once passkeys are registered.
		console.warn(
			`[zembil] ZEMBIL_RP_ID (${rpId}) is a proper suffix of the origin hostname (${hostname}). ` +
				'This widens WebAuthn scope to every sibling subdomain — see CONTRACT.md §6 / D-022.'
		);
	}

	if (env.PROTOCOL_HEADER || env.HOST_HEADER) {
		// §6: these adapter-node variables would let a client control what the
		// app believes its own origin is, defeating the Origin check and
		// WebAuthn's expectedOrigin/expectedRPID. Never load-bearing here.
		console.warn(
			'[zembil] PROTOCOL_HEADER or HOST_HEADER is set. CONTRACT.md §6 requires these to stay unset.'
		);
	}

	const rpName = env.ZEMBIL_RP_NAME?.trim() || 'Zembil';
	const trustProxy = parseIntEnv(env, 'ZEMBIL_TRUST_PROXY', 1, { min: 0, max: 20 });
	const bootstrapUsername = env.ZEMBIL_BOOTSTRAP_ADMIN_USERNAME?.trim() || 'admin';
	const bootstrapPassword = env.ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD || null;
	const sessionIdleDays = parseIntEnv(env, 'ZEMBIL_SESSION_IDLE_DAYS', 30, { min: 1, max: 3650 });
	const sessionAbsoluteDays = parseIntEnv(env, 'ZEMBIL_SESSION_ABSOLUTE_DAYS', 180, {
		min: 1,
		max: 3650
	});
	if (sessionAbsoluteDays < sessionIdleDays) {
		throw new Error(
			`ZEMBIL_SESSION_ABSOLUTE_DAYS (${sessionAbsoluteDays}) must be >= ZEMBIL_SESSION_IDLE_DAYS (${sessionIdleDays}).`
		);
	}

	const logLevelRaw = env.ZEMBIL_LOG_LEVEL?.trim() || 'info';
	if (!LOG_LEVELS.has(logLevelRaw)) {
		throw new Error(`ZEMBIL_LOG_LEVEL must be one of debug|info|warn|error, got: ${logLevelRaw}`);
	}

	return {
		origin,
		originIsHttps,
		rpId,
		rpName,
		trustProxy,
		bootstrapUsername,
		bootstrapPassword,
		sessionIdleDays,
		sessionAbsoluteDays,
		logLevel: logLevelRaw as AuthConfig['logLevel']
	};
}

let cached: AuthConfig | null = null;

/** The application's single, lazily-computed configuration. */
export function getConfig(): AuthConfig {
	if (cached === null) cached = loadConfig();
	return cached;
}

/** Test seam, mirroring `setDb(null)` in `$lib/server/db`. Not used by application code. */
export function resetConfig(): void {
	cached = null;
}
