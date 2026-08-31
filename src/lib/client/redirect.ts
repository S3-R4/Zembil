/**
 * Where `/login?next=…` is allowed to send someone.
 *
 * An open redirect on a sign-in screen is the classic phishing primitive: a
 * link that really does go to the family's own hostname, really does sign the
 * member in, and then lands them somewhere else entirely.
 */

/** Control characters, which can smuggle a newline or a NUL past a naive check
 *  further up the stack. */
const CONTROL = /[\u0000-\u001f\u007f]/;

export function safeNext(target: string | null, fallback = '/'): string {
	if (!target) return fallback;
	// Must be a path on this site. `//evil.example` is a protocol-relative URL
	// that a browser treats as absolute, and `/\evil.example` is the same trick
	// with the slash the other way round — several parsers fold the backslash.
	if (!target.startsWith('/')) return fallback;
	if (target.startsWith('//') || target.startsWith('/\\')) return fallback;
	if (CONTROL.test(target)) return fallback;
	return target;
}
