/**
 * Copy one short string to the clipboard, with the fallback that makes it work
 * where the modern API does not.
 *
 * Written for exactly one caller: the admin screen's one-time password, which
 * the server generates, shows once, and stores only the hash of. That is what
 * makes the fallback worth having rather than a nicety — if the copy silently
 * fails, the only copy of that password is gone.
 *
 * `navigator.clipboard.writeText` needs a secure context AND, in some browsers,
 * a permission the page may not have. Zembil is always served over HTTPS in
 * production, so the modern path is the normal one; the `execCommand` path
 * covers the rest, and is deliberately synchronous — it must run inside the
 * click's own task or the browser refuses it as untrusted.
 *
 * Returns whether the text actually reached the clipboard, so the UI can say
 * "write it down instead" rather than claim a success it did not have.
 */
export async function copyText(text: string): Promise<boolean> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through: denied permission, or a browser that exposes the API
			// outside a secure context and then refuses.
		}
	}
	return legacyCopy(text);
}

/**
 * The `document.execCommand('copy')` path. Deprecated, and still the only thing
 * that works in several real browsers.
 *
 * The textarea is off-screen rather than `display: none` — a hidden element
 * cannot be selected, so the copy would silently produce an empty string, which
 * is the exact failure this function exists to report rather than hide. It is
 * removed in a `finally`, so the password never outlives the call in the DOM.
 */
function legacyCopy(text: string): boolean {
	if (typeof document === 'undefined') return false;
	const node = document.createElement('textarea');
	node.value = text;
	node.setAttribute('readonly', '');
	node.setAttribute('aria-hidden', 'true');
	node.style.position = 'fixed';
	node.style.top = '-1000px';
	node.style.opacity = '0';
	document.body.appendChild(node);
	try {
		node.select();
		node.setSelectionRange(0, text.length);
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		node.remove();
	}
}
