import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { LOCALES } from '$lib/types';

const root = new URL('../../', import.meta.url);

describe('localised public PWA assets', () => {
	test('every locale has a static offline page labelled in that language', () => {
		for (const locale of LOCALES) {
			const html = readFileSync(new URL(`static/offline-${locale}.html`, root), 'utf8');
			expect(html).toContain(`<html lang="${locale}">`);
			expect(html).toContain('location.reload()');
			expect(html).not.toMatch(/Migros|shopping item|claimedBy|session/i);
		}
	});

	test('every locale has the same manifest identity and translated metadata', () => {
		const manifests = LOCALES.map((locale) =>
			JSON.parse(readFileSync(new URL(`static/manifest-${locale}.webmanifest`, root), 'utf8'))
		);
		for (const [index, locale] of LOCALES.entries()) {
			const manifest = manifests[index];
			expect(manifest.lang).toBe(locale);
			expect(manifest.description).toBeTruthy();
			expect(manifest.name).toBe('Zembil');
			expect(manifest.id).toBe('/');
			expect(manifest.scope).toBe('/');
			expect(manifest.icons).toEqual(manifests[0].icons);
		}
		expect(new Set(manifests.map((manifest) => manifest.description)).size).toBe(LOCALES.length);
	});
});
