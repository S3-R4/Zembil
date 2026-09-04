/** Documentation invariants which are easy to update in one place and miss in another. */
import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const project = read('PROJECT.md');
const decisions = read('docs/DECISIONS.md');
const versions = read('docs/VERSIONS.md');
const readme = read('README.md');

const requiredNumber = (text: string, pattern: RegExp, label: string): number => {
	const match = text.match(pattern);
	expect(match, label).not.toBeNull();
	return Number(match?.[1]);
};

describe('PROJECT.md stays internally consistent', () => {
	test('status and completion checklist quote the same test counts', () => {
		const unitStatus = requiredNumber(
			project,
			/Unit\/integration tests\s*\|\s*\*\*(\d+)\*\*/,
			'unit status'
		);
		const unitChecklist = requiredNumber(project, /npm test` \(Vitest, (\d+)\)/, 'unit checklist');
		expect(unitChecklist).toBe(unitStatus);

		const e2eStatus = requiredNumber(
			project,
			/End-to-end specs\s*\|\s*\*\*(\d+)\*\*/,
			'e2e status'
		);
		const e2eChecklist = requiredNumber(
			project,
			/test:e2e` \(Playwright, (\d+)\)/,
			'e2e checklist'
		);
		expect(e2eChecklist).toBe(e2eStatus);

		const e2eDir = new URL('tests/e2e/', root);
		const actualE2e = readdirSync(e2eDir)
			.filter((name) => /\.(?:spec|setup)\.js$/.test(name))
			.map((name) => readFileSync(join(e2eDir.pathname, name), 'utf8'))
			.reduce((count, source) => count + [...source.matchAll(/^\s*(?:test|setup)\(/gm)].length, 0);
		expect(e2eStatus).toBe(actualE2e);

		const release = versions.match(/^## v([\d.]+) — (\d{4}-\d{2}-\d{2})$/m);
		expect(release, 'latest release heading').not.toBeNull();
		const packageVersion = JSON.parse(read('package.json')).version as string;
		const displayVersion = packageVersion.replace(/\.0$/, '');
		expect(release?.[1]).toBe(displayVersion);
		expect(project).toContain(`**v${displayVersion} — ${release?.[2]}**`);
		const renderedDate = new Intl.DateTimeFormat('en-GB', {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(`${release?.[2]}T00:00:00.000Z`));
		expect(readme).toContain(`Zembil v${displayVersion} · as of ${renderedDate}`);
	});

	test('the documented decision range reaches the latest D-entry', () => {
		const ids = [...decisions.matchAll(/^## D-(\d+)\b/gm)].map((match) => Number(match[1]));
		const documented = requiredNumber(project, /D-001 … \*\*D-(\d+)\*\*/, 'decision range');
		expect(documented).toBe(Math.max(...ids));
	});

	test('the documented migration number is the latest migration file', () => {
		const migrationDir = new URL('src/lib/server/db/migrations/', root);
		const latest = Math.max(
			...readdirSync(migrationDir).map((name) => Number(name.match(/^(\d+)_/)?.[1] ?? 0))
		);
		const documented = requiredNumber(
			project,
			/Migrations applied\s*\|\s*\*\*(\d+)\*\*/,
			'migration status'
		);
		expect(documented).toBe(latest);
	});
});
