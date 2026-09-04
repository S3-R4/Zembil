/**
 * Identity used only for suggestions and duplicate warnings.
 *
 * Item names are deliberately not unique. This key answers the softer question
 * “would a person read these as the same item?” without ever reaching a write
 * constraint. Application code owns the Unicode fold because SQLite NOCASE is
 * ASCII-only and therefore wrong for Turkish.
 */
export function itemNameKey(name: string): string {
	return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}
