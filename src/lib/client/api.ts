/**
 * The single fetch wrapper — CONTRACT.md §3.1.
 *
 * Every non-2xx response in this API carries `{ error: { code, message } }`,
 * and `message` is written to be shown to a person. So the client never invents
 * error copy: it shows what the server said. A screen that renders its own
 * "Something went wrong" hides the `409 STORE_NAME_TAKEN` that would have told
 * the member exactly what to do.
 */
export class ApiError extends Error {
	readonly code: string;
	readonly status: number;
	/** The whole parsed body, so a caller can reach the three named sibling
	 *  fields §3.1 permits (`item`, `openTripId`, `storeId`). */
	readonly body: Record<string, unknown>;

	constructor(status: number, code: string, message: string, body: Record<string, unknown>) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.body = body;
	}
}

/** Thrown when the request never reached the server. Distinct from ApiError so
 *  the UI can say "No signal" and offer Retry rather than blaming the server. */
export class OfflineError extends Error {
	constructor() {
		super('No signal.');
		this.name = 'OfflineError';
	}
}

export interface ApiOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	body?: unknown;
	signal?: AbortSignal;
	/** Only load functions pass this; everything else uses the global fetch. */
	fetch?: typeof globalThis.fetch;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
	const method = options.method ?? 'GET';
	const doFetch = options.fetch ?? globalThis.fetch;

	let response: Response;
	try {
		response = await doFetch(path, {
			method,
			headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			// Same-origin only. The browser adds `Origin` itself on every method
			// except GET and HEAD, which is what the §3 origin check reads; there is
			// nothing for the client to set, and nothing it could set that would
			// help if it were wrong.
			credentials: 'same-origin',
			signal: options.signal
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') throw err;
		throw new OfflineError();
	}

	if (response.status === 204) return undefined as T;

	const text = await response.text();
	let parsed: unknown = null;
	if (text.length > 0) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = null;
		}
	}

	if (!response.ok) {
		const body = (parsed ?? {}) as Record<string, unknown>;
		const error = (body.error ?? {}) as { code?: string; message?: string };
		throw new ApiError(
			response.status,
			error.code ?? 'INTERNAL',
			error.message ?? 'Something went wrong. Please try again.',
			body
		);
	}

	return parsed as T;
}

/** §3.5: one clientId per compose, reused across every retry of that compose. */
export function newClientId(): string {
	return crypto.randomUUID();
}
