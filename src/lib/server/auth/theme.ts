/**
 * Interface theme — the validator for `PATCH /api/me`.
 *
 * Deliberately the same shape as `validateLocale` next door, and for the same
 * reason: `users.theme` carries a CHECK constraint, so an unrecognised value
 * would otherwise reach SQLite and come back as a 500 where the contract
 * promises a 400.
 *
 * There is no negotiation counterpart to `negotiateAcceptLanguage`. A browser
 * does send `prefers-color-scheme`, but only as a CSS media feature and not as
 * a request header we could read, and the default `auto` already honours it in
 * the stylesheet — which is the correct place for it, since it keeps working
 * when the member changes their OS setting without reloading.
 */
import { THEMES, type Theme } from '$lib/types';
import { DomainError } from '../domain/errors.js';

function isTheme(value: string): value is Theme {
	return (THEMES as readonly string[]).includes(value);
}

/**
 * One of the exact strings, or `400 VALIDATION_FAILED`. No trimming, no case
 * folding, no nearest match — the same strictness `validateLocale` applies, so
 * a typo in a client is a loud failure rather than a silent reset to `auto`.
 */
export function validateTheme(value: unknown): Theme {
	if (typeof value !== 'string' || !isTheme(value)) {
		throw new DomainError('VALIDATION_FAILED', 400, `Theme must be one of ${THEMES.join(', ')}.`);
	}
	return value;
}
