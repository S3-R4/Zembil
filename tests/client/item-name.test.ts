import { describe, expect, test } from 'vitest';
import { itemNameKey } from '$lib/item-name';

describe('itemNameKey', () => {
	test('normalises compatibility forms, case and Unicode whitespace', () => {
		expect(itemNameKey('  ＭİＬＫ\n  Bread  ')).toBe(itemNameKey('ｍi̇lk bread'));
	});

	test('does not strip meaningful punctuation', () => {
		expect(itemNameKey('Milk-free')).not.toBe(itemNameKey('Milk free'));
	});
});
