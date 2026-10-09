/**
 * Origin pinning for the production server.
 *
 * adapter-node 6 has no runtime ORIGIN variable: it builds request.url from
 * request headers and defaults the protocol to `https`, which breaks form
 * POSTs (CSRF 403) when the app is served over plain HTTP. Instead of trusting
 * client-supplied forwarding headers, we pin the public origin from the ORIGIN
 * environment variable: PROTOCOL_HEADER/HOST_HEADER are set before the handler
 * is imported, and every request gets x-forwarded-proto/x-forwarded-host
 * overwritten with the ORIGIN values — spoofed values never reach SvelteKit.
 */

/**
 * Parses and validates an ORIGIN value: http(s) scheme, host[:port], and no
 * path, query, fragment, or credentials.
 *
 * @param {string} value
 * @returns {URL}
 */
export function parseOrigin(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`ORIGIN is not a valid URL: ${JSON.stringify(value)}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`ORIGIN must use http or https: ${JSON.stringify(value)}`);
	}
	if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
		throw new Error(`ORIGIN must not include a path, query, or fragment: ${JSON.stringify(value)}`);
	}
	if (url.username !== '' || url.password !== '') {
		throw new Error(`ORIGIN must not include credentials: ${JSON.stringify(value)}`);
	}
	return url;
}

/**
 * Removes client-supplied forwarding headers and sets them from the trusted
 * origin instead.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} origin
 */
export function pinOriginHeaders(req, origin) {
	delete req.headers['x-forwarded-proto'];
	delete req.headers['x-forwarded-host'];
	req.headers['x-forwarded-proto'] = origin.protocol.replace(':', '');
	req.headers['x-forwarded-host'] = origin.host;
}

/**
 * Normalizes an IP for comparison: trims, drops an IPv6-mapped IPv4 prefix,
 * and drops a port suffix accidentally attached to an IPv4 address.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeIp(value) {
	const ip = value.trim().toLowerCase();
	if (ip.startsWith('::ffff:')) return ip.slice(7);
	return ip;
}

/**
 * Parses TRUSTED_PROXIES into a matcher. `*` trusts every peer — use only when
 * the process can never be reached directly. Otherwise an exact match against
 * the immediate peer's address (the reverse proxy). Returns null when unset.
 *
 * @param {string | undefined} value
 * @returns {((ip: string) => boolean) | null}
 */
export function trustedProxyMatcher(value) {
	if (!value) return null;
	const entries = value
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
	if (entries.includes('*')) return () => true;
	const set = new Set(entries.map(normalizeIp));
	return (ip) => set.has(normalizeIp(ip));
}

/**
 * Resolves the client IP for this request.
 *
 * When the immediate peer is a trusted proxy, its `x-forwarded-for` chain is
 * authoritative and the client is the leftmost entry. Otherwise the header is
 * client-supplied fiction and the socket address is used — the value is always
 * written back into x-forwarded-for so SvelteKit's getClientAddress and Better
 * Auth's IP reads see an honest value.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {((ip: string) => boolean) | null} isTrusted
 * @returns {string}
 */
export function resolveClientIp(req, isTrusted) {
	const socketIp = normalizeIp(req.socket?.remoteAddress ?? '');
	if (isTrusted && isTrusted(socketIp)) {
		const xff = req.headers['x-forwarded-for'];
		const chain = (Array.isArray(xff) ? xff.join(',') : (xff ?? '')).split(',');
		const client = chain.map((v) => v.trim()).filter(Boolean)[0];
		if (client) return client;
	}
	return socketIp;
}
