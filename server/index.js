/**
 * Production entry point: `node server/index.js` (after `npm run build`).
 *
 * Wraps adapter-node's handler to pin the public origin at runtime (see
 * ./origin.js). ORIGIN is always required by this server — it is the
 * production entry point; `vite dev` covers development. Graceful shutdown
 * mirrors adapter-node's own index.js, including the `sveltekit:shutdown`
 * process event.
 */
import http from 'node:http';
import process from 'node:process';
import { parseOrigin, pinOriginHeaders, resolveClientIp, trustedProxyMatcher } from './origin.js';

const originEnv = process.env.ORIGIN;
if (!originEnv) {
	console.error(
		'ORIGIN is required (e.g. ORIGIN=http://localhost:3000). It is the public URL of the app and is used as the Better Auth baseURL and to pin the request origin.'
	);
	process.exit(1);
}

/** @type {URL} */
let origin;
try {
	origin = parseOrigin(originEnv);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

// Must be set before the adapter-node handler module is evaluated: it reads
// these variables once at module scope.
process.env.PROTOCOL_HEADER = 'x-forwarded-proto';
process.env.HOST_HEADER = 'x-forwarded-host';

const host = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000');
const shutdown_timeout = parseInt(process.env.SHUTDOWN_TIMEOUT || '30');
// Comma-separated reverse-proxy IPs allowed to supply x-forwarded-for, or `*`
// when the process is only ever reachable through a proxy. Unset = nobody may.
const isTrustedProxy = trustedProxyMatcher(process.env.TRUSTED_PROXIES);

/** @type {typeof import('../build/handler.js').handler} */
let handler;
try {
	({ handler } = await import('../build/handler.js'));
} catch (error) {
	console.error('Could not load ../build/handler.js — run `npm run build` first.');
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exit(1);
}

const server = http.createServer();

/** @type {NodeJS.Timeout | void} */
let shutdown_timeout_id;

server.on('request', (req, res) => {
	pinOriginHeaders(req, origin);
	req.headers['x-forwarded-for'] = resolveClientIp(req, isTrustedProxy);

	req.on('close', () => {
		if (shutdown_timeout_id) {
			// close connections as soon as they become idle, so they don't accept new requests
			server.closeIdleConnections();
		}
	});

	handler(req, res, () => {
		res.statusCode = 404;
		res.end();
	});
});

server.listen({ host, port }, () => {
	console.log(`Listening on http://${host}:${port} (origin: ${origin.origin})`);
});

/** @param {'SIGINT' | 'SIGTERM'} reason */
function graceful_shutdown(reason) {
	if (shutdown_timeout_id) return;

	// close() waits for keep-alive connections to time out instead of closing
	// them if they are idle, so close them first
	server.closeIdleConnections();

	server.close((error) => {
		// occurs if the server is already closed
		if (error) return;
		if (shutdown_timeout_id) clearTimeout(shutdown_timeout_id);
		process.emit('sveltekit:shutdown', reason);
	});

	shutdown_timeout_id = setTimeout(() => server.closeAllConnections(), shutdown_timeout * 1000);
}

process.on('SIGTERM', graceful_shutdown);
process.on('SIGINT', graceful_shutdown);
