/**
 * Returns a safe same-origin redirect target: a path starting with a single
 * `/`, without backslashes or whitespace. Anything else falls back to `/`.
 */
export function sanitizeRedirectTo(value: FormDataEntryValue | string | null | undefined): string {
	if (typeof value !== 'string' || value.length === 0) return '/';
	const safe = /^\/(?!\/)[^\s\\]*$/.test(value);
	return safe ? value : '/';
}
