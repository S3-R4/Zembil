import { rmSync } from 'node:fs';

/**
 * A clean database for every run. The suite asserts on bootstrap behaviour and
 * on trip numbering, both of which are only meaningful from an empty file — and
 * a suite that passes only on a second run is a suite nobody trusts.
 */
export default function globalSetup() {
	rmSync('.playwright-data', { recursive: true, force: true });
	rmSync('tests/e2e/.auth', { recursive: true, force: true });
}
