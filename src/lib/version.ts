/**
 * The application version — the one place it is written.
 *
 * `package.json` carries the same string, and a test asserts the two agree
 * (`tests/client/version.test.ts`), because a version that disagrees with
 * itself is worse than no version at all. `package.json` cannot be the source
 * directly: importing it into a module the client bundles would ship the whole
 * manifest — dependency names, versions and scripts — to every browser, which
 * is exactly the fingerprint `GET /api/health` refuses to hand out (§3.8).
 *
 * ## The scheme
 *
 * `0.<milestone>.<patch>`, and there is nothing clever about it:
 *
 *   - **minor = the milestone number.** M8 shipped `0.8.0`. The next milestone
 *     is `0.9.0` whether it is large or small, because the milestone is the unit
 *     this project actually plans, tests, audits and documents in.
 *   - **patch = a fix shipped between milestones.** A bug fix, a copy change, a
 *     closed audit finding.
 *   - **still `0.x`** because the frozen contract is the compatibility promise
 *     here, not the version number. There is one deployment, one family, and no
 *     third-party integrator for a `1.0` to mean anything to. If Zembil ever
 *     grows an external API consumer, that is the milestone that earns the major
 *     bump — and it should say so in a D-entry.
 *
 * `RELEASED_ON` is the date that version was cut, as `YYYY-MM-DD`. It is a
 * literal rather than a build timestamp on purpose: a build timestamp changes
 * every time the image is rebuilt, so "as of" would drift without a single line
 * of the app having changed, and an operator comparing two containers could not
 * tell a rebuild from a release.
 *
 * ## When you ship anything
 *
 * Bump both constants here, the `version` in `package.json`, and the top of
 * `docs/VERSIONS.md`. PROJECT.md §2 quotes the current version too. All four
 * are asserted or read by something, so none of them is decoration.
 */
export const VERSION = '0.9.1';

/** `YYYY-MM-DD`, in UTC, of the day this version was cut. */
export const RELEASED_ON = '2026-09-03';

/**
 * What the interface shows: `v0.8` for a release, `v0.8.1` for a patch on top
 * of one.
 *
 * The patch segment is dropped when it is zero because a milestone release is
 * the thing a member might mention out loud ("I'm on v0.8"), and a trailing
 * `.0` is noise in that sentence. It is NOT dropped when it is non-zero — a
 * patch is precisely the case where the exact build matters, since it is what
 * distinguishes a phone that has the fix from one that has not.
 */
export function displayVersion(version = VERSION): string {
	const [major, minor, patch] = version.split('.');
	return patch === '0' ? `v${major}.${minor}` : `v${major}.${minor}.${patch}`;
}

/** `RELEASED_ON` as epoch milliseconds, for a date formatter. Parsed as UTC
 *  (the `YYYY-MM-DD` form is UTC by spec), so the rendered day does not shift
 *  by one for a reader west of Greenwich. */
export function releasedAt(on = RELEASED_ON): number {
	return Date.parse(`${on}T00:00:00Z`);
}
