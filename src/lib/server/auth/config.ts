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
	/** §3.9. Master switch for web push. Everything else about push is
	 *  self-provisioning, so this exists only as an operator kill switch. */
	pushEnabled: boolean;
	/**
	 * §8.7 VAPID `sub` claim: a `mailto:` or `https:` URL identifying the sender
	 * to the push service. Defaults to the origin, so there is nothing to
	 * provision — but ONLY when the origin is `https:`, because RFC 8292 admits
	 * no other scheme and `web-push` enforces it.
	 *
	 * `null` on a plain-`http:` origin, which is the local development case. No
	 * valid contact URI can be derived from `http://localhost:5173`, and
	 * fabricating one would be a lie in a JWT. Delivery declines to send with one
	 * log line instead; a browser cannot receive real web push against a
	 * non-HTTPS deployment anyway, so nothing is lost that was ever going to work.
	 */
	vapidSubject: string | null;
	/**
	 * §3.9. A store's added items are held back until the list has been quiet
	 * for this long, then delivered as ONE notification. This is the whole
	 * anti-spam mechanism: five people adding eleven things over a minute is one
	 * buzz, not eleven.
	 */
	notifyQuietMinutes: number;
	/**
	 * The ceiling on that hold-back. Without it a list somebody keeps touching
	 * never goes quiet and the notification never arrives at all.
	 */
	notifyMaxDelayMinutes: number;
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

	// §3.9. `false` only for an explicit off switch; anything else is on, because
	// the failure mode of a typo here should be "notifications still work".
	const pushEnabledRaw = env.ZEMBIL_PUSH_ENABLED?.trim().toLowerCase();
	const pushEnabled = !(pushEnabledRaw === '0' || pushEnabledRaw === 'false' || pushEnabledRaw === 'no');

	// An explicitly set value is always validated and a bad one crashes the
	// process, per §6's standard. The DEFAULT is derived, and a derived value
	// that cannot be valid becomes null rather than an error — an operator who
	// never set this variable should not be told they got it wrong.
	const vapidSubjectRaw = env.ZEMBIL_VAPID_SUBJECT?.trim();
	let vapidSubject: string | null;
	if (vapidSubjectRaw) {
		if (vapidSubjectRaw.length > 200) {
			throw new Error('ZEMBIL_VAPID_SUBJECT is too long (max 200).');
		}
		if (!/^(mailto:|https:\/\/)/.test(vapidSubjectRaw)) {
			throw new Error(
				`ZEMBIL_VAPID_SUBJECT must be a mailto: or https:// URL, got: ${vapidSubjectRaw}`
			);
		}
		vapidSubject = vapidSubjectRaw;
	} else {
		vapidSubject = originIsHttps ? origin : null;
	}

	const notifyQuietMinutes = parseIntEnv(env, 'ZEMBIL_NOTIFY_QUIET_MINUTES', 5, {
		min: 0,
		max: 240
	});
	const notifyMaxDelayMinutes = parseIntEnv(env, 'ZEMBIL_NOTIFY_MAX_DELAY_MINUTES', 30, {
		min: 1,
		max: 1440
	});
	if (notifyMaxDelayMinutes < notifyQuietMinutes) {
		throw new Error(
			`ZEMBIL_NOTIFY_MAX_DELAY_MINUTES (${notifyMaxDelayMinutes}) must be >= ` +
				`ZEMBIL_NOTIFY_QUIET_MINUTES (${notifyQuietMinutes}).`
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
		logLevel: logLevelRaw as AuthConfig['logLevel'],
		pushEnabled,
		vapidSubject,
		notifyQuietMinutes,
		notifyMaxDelayMinutes
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
