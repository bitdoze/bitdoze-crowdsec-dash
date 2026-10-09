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
