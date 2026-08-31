/** CONTRACT.md §6 — environment variables, and the rpID one-way door. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '$lib/server/auth/config';

const base = { ZEMBIL_ORIGIN: 'https://zembil.example.com' };
const load = (env: Record<string, string> = {}) =>
	loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);

afterEach(() => vi.restoreAllMocks());

describe('ZEMBIL_ORIGIN', () => {
	it('is required — startup fails if unset or unparseable', () => {
		expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/ZEMBIL_ORIGIN is required/);
		expect(() => loadConfig({ ZEMBIL_ORIGIN: 'not a url' } as NodeJS.ProcessEnv)).toThrow(
			/not a valid URL/
		);
		expect(() => loadConfig({ ZEMBIL_ORIGIN: 'ftp://x.example' } as NodeJS.ProcessEnv)).toThrow(
			/must be http or https/
		);
	});

	it('must be an origin, with no path, query or fragment', () => {
		for (const origin of [
			'https://zembil.example.com/app',
			'https://zembil.example.com/?a=1',
			'https://zembil.example.com/#x'
		]) {
			expect(() => loadConfig({ ZEMBIL_ORIGIN: origin } as NodeJS.ProcessEnv), origin).toThrow(
				/no path, query or fragment/
			);
		}
		expect(load().origin).toBe('https://zembil.example.com');
		expect(loadConfig({ ZEMBIL_ORIGIN: 'https://zembil.example.com/' } as NodeJS.ProcessEnv).origin)
			.toBe('https://zembil.example.com');
	});

	it('drives originIsHttps, which decides the __Host- cookie name (§5)', () => {
		expect(load().originIsHttps).toBe(true);
		expect(loadConfig({ ZEMBIL_ORIGIN: 'http://localhost:5173' } as NodeJS.ProcessEnv).originIsHttps)
			.toBe(false);
	});
});

describe('ZEMBIL_RP_ID (§6 — a one-way door)', () => {
	it('defaults to the FULL hostname, never the registrable domain', () => {
		expect(load().rpId).toBe('zembil.example.com');
	});

	it('accepts the exact hostname without a warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(load({ ZEMBIL_RP_ID: 'zembil.example.com' }).rpId).toBe('zembil.example.com');
		expect(warn).not.toHaveBeenCalled();
	});

	it('warns loudly on a proper suffix, which widens scope to every sibling subdomain', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(load({ ZEMBIL_RP_ID: 'example.com' }).rpId).toBe('example.com');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0].join(' ')).toMatch(/sibling subdomain/);
	});

	it('refuses an rpID that is not a suffix at all', () => {
		expect(() => load({ ZEMBIL_RP_ID: 'evil.example' })).toThrow(/must be exactly the hostname/);
		// Not a *label* suffix: `mbil.example.com` is a string suffix and must not pass.
		expect(() => load({ ZEMBIL_RP_ID: 'mbil.example.com' })).toThrow(/must be exactly the hostname/);
	});
});

describe('PROTOCOL_HEADER / HOST_HEADER (§6)', () => {
	it('warns when set, because they would let a client define our own origin', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		load({ PROTOCOL_HEADER: 'x-forwarded-proto' });
		expect(warn.mock.calls.join(' ')).toMatch(/PROTOCOL_HEADER or HOST_HEADER/);
	});
});

describe('numeric settings', () => {
	it('defaults per the §6 table', () => {
		const config = load();
		expect(config.trustProxy).toBe(1);
		expect(config.sessionIdleDays).toBe(30);
		expect(config.sessionAbsoluteDays).toBe(180);
		expect(config.rpName).toBe('Zembil');
		expect(config.bootstrapUsername).toBe('admin');
		expect(config.bootstrapPassword).toBeNull();
		expect(config.logLevel).toBe('info');
	});

	it('rejects a non-integer, and `1e300`, which Number.isInteger would admit', () => {
		expect(() => load({ ZEMBIL_TRUST_PROXY: 'two' })).toThrow(/must be an integer/);
		expect(() => load({ ZEMBIL_TRUST_PROXY: '1.5' })).toThrow(/must be an integer/);
		expect(() => load({ ZEMBIL_TRUST_PROXY: '1e300' })).toThrow();
		expect(() => load({ ZEMBIL_SESSION_IDLE_DAYS: '9007199254740993' })).toThrow();
	});

	it('bounds each one', () => {
		expect(() => load({ ZEMBIL_TRUST_PROXY: '-1' })).toThrow(/must be >= 0/);
		expect(() => load({ ZEMBIL_TRUST_PROXY: '21' })).toThrow(/must be <= 20/);
		expect(() => load({ ZEMBIL_SESSION_IDLE_DAYS: '0' })).toThrow(/must be >= 1/);
		expect(load({ ZEMBIL_TRUST_PROXY: '0' }).trustProxy).toBe(0);
	});

	it('refuses an absolute TTL shorter than the idle one', () => {
		expect(() =>
			load({ ZEMBIL_SESSION_IDLE_DAYS: '90', ZEMBIL_SESSION_ABSOLUTE_DAYS: '30' })
		).toThrow(/must be >= ZEMBIL_SESSION_IDLE_DAYS/);
	});

	it('validates ZEMBIL_LOG_LEVEL against the enum', () => {
		expect(load({ ZEMBIL_LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
		expect(() => load({ ZEMBIL_LOG_LEVEL: 'verbose' })).toThrow(/must be one of/);
	});
});
