/**
 * Domain errors — CONTRACT.md §3.1.
 *
 * The domain layer knows nothing about HTTP beyond a status number: it returns
 * plain objects and throws these. Routes turn them into the error envelope.
 * `extra` carries the two — three, see the note in the M1 report — named sibling
 * fields §3.1 permits, and those are the only keys ever merged next to `error`.
 */
export type ErrorExtra = Record<string, unknown> | undefined;

export class DomainError extends Error {
	readonly code: string;
	readonly status: number;
	readonly extra: ErrorExtra;

	constructor(code: string, status: number, message: string, extra?: ErrorExtra) {
		super(message);
		this.name = 'DomainError';
		this.code = code;
		this.status = status;
		this.extra = extra;
	}
}

export const validationFailed = (message = 'That value is not valid.') =>
	new DomainError('VALIDATION_FAILED', 400, message);

export const notFound = (code: string, message: string) => new DomainError(code, 404, message);

/** §3.1 shared code. R-20 uses it for releasing someone else's claim. */
export const forbidden = (message: string) => new DomainError('FORBIDDEN', 403, message);

export const conflict = (code: string, message: string, extra?: ErrorExtra) =>
	new DomainError(code, 409, message, extra);

export function isDomainError(err: unknown): err is DomainError {
	return err instanceof DomainError;
}
