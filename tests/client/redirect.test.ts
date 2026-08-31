/** `/login?next=…` — the open-redirect guard. */
import { describe, expect, it } from 'vitest';
import { safeNext } from '$lib/client/redirect';

describe('safeNext', () => {
	it('keeps a same-site path', () => {
		expect(safeNext('/')).toBe('/');
		expect(safeNext('/s/abc123')).toBe('/s/abc123');
		expect(safeNext('/trips?store=x')).toBe('/trips?store=x');
	});

	it('falls back when there is nothing to honour', () => {
		expect(safeNext(null)).toBe('/');
		expect(safeNext('')).toBe('/');
	});

	it('refuses anything that leaves this site', () => {
		for (const target of [
			'https://evil.example',
			'http://evil.example',
			// Protocol-relative: a browser reads this as absolute.
			'//evil.example',
			// The same trick with the other slash; several parsers fold it.
			'/\\evil.example',
			'javascript:alert(1)',
			'data:text/html,<script>',
			'evil.example'
		]) {
			expect(safeNext(target), target).toBe('/');
		}
	});

	it('refuses a control character', () => {
		expect(safeNext('/ok\nSet-Cookie: x=1')).toBe('/');
		expect(safeNext('/ok\u0000')).toBe('/');
		expect(safeNext('/ok\r')).toBe('/');
		expect(safeNext('/ok\u007f')).toBe('/');
	});
});
