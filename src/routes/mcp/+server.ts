/**
 * MCP endpoint — Streamable HTTP, JSON-only responses (no SSE: every reply
 * is a direct answer to the request, which the spec permits).
 *
 * Auth: the same `Authorization: Bearer csd_…` API key as /api/v1; tool
 * scopes mirror REST — `operate` keys may ban/unban, everything else is read.
 *
 * Supported methods: initialize, ping, notifications/*, tools/list,
 * tools/call. The server answers with its own MCP-Protocol-Version.
 */
import type { RequestHandler } from './$types';
import { apiAuth, bodyTooBig, jsonErr } from '#lib/server/api/http.ts';
import {
	ApiError,
	alertById,
	alerts,
	createDecision,
	decisions,
	lookupIp,
	notifications,
	removeDecision,
	siteById,
	sites,
	status
} from '#lib/server/api/v1.ts';
import { APP_VERSION } from '#lib/server/ops.ts';
import { db } from '#lib/server/db/index.ts';
import type { ApiPrincipal } from '#lib/server/api-keys.ts';
import { config } from '#lib/server/config.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, '2025-03-26'];

const tool = (
	name: string,
	description: string,
	properties: object = {},
	required: string[] = []
) => ({
	name,
	description,
	inputSchema: { type: 'object' as const, properties, additionalProperties: false, required }
});

const TOOLS = [
	tool('status', 'Dashboard version, CrowdSec connectivity, and per-source sync freshness.'),
	tool('list_alerts', 'Stored CrowdSec alerts (newest first).', {
		siteId: { type: 'string', description: 'Filter to one site id' },
		scenario: { type: 'string', description: 'Substring match on scenario' },
		ip: { type: 'string', description: 'Substring match on source IP/value' },
		sinceHours: { type: 'number', description: 'Only alerts started within N hours' },
		page: { type: 'number' }
	}),
	tool(
		'get_alert',
		'One alert by upstream id.',
		{
			id: { type: 'number', description: 'CrowdSec alert id' }
		},
		['id']
	),
	tool('list_decisions', 'Decision projection — bans/captchas, active by default.', {
		q: { type: 'string', description: 'Substring match on value/scenario/origin' },
		includeExpired: { type: 'boolean' },
		page: { type: 'number' }
	}),
	tool(
		'lookup_ip',
		'Alerts, decisions, and geo for one IP address.',
		{
			ip: { type: 'string' }
		},
		['ip']
	),
	tool('list_sites', 'Site inventory: hostname, proxy, runtime, WAF level.'),
	tool('get_site', 'One site by id.', { id: { type: 'string' } }, ['id']),
	tool('list_notifications', 'Inbox events (outages, job results, alerts).', {
		limit: { type: 'number', description: 'Max rows, 1–200 (default 50)' }
	}),
	tool(
		'ban_ip',
		'Push a ban or captcha decision for an IP/CIDR. Needs an operate-scope key; reconciles upstream on the next sync.',
		{
			ip: { type: 'string', description: 'IPv4/IPv6 or CIDR' },
			duration: { type: 'string', description: 'e.g. 4h, 90m, 2d (max 30d, default 4h)' },
			reason: { type: 'string' },
			type: { type: 'string', enum: ['ban', 'captcha'] }
		},
		['ip']
	),
	tool(
		'unban_ip',
		'Request removal of an active decision by its id (from list_decisions). Needs an operate-scope key.',
		{
			id: { type: 'number' },
			value: {
				type: 'string',
				description: 'Decision value — only needed if not in the local projection'
			}
		},
		['id']
	)
];

const qs = (args: Record<string, unknown>): URLSearchParams => {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) p.set(k, String(v));
	return p;
};

async function callTool(p: ApiPrincipal, name: string, args: Record<string, unknown>) {
	switch (name) {
		case 'status':
			return status(db);
		case 'list_alerts':
			return alerts(db, p, qs(args));
		case 'get_alert':
			return alertById(db, p, String(args.id ?? ''));
		case 'list_decisions':
			return decisions(db, p, qs(args));
		case 'lookup_ip':
			return lookupIp(db, p, String(args.ip ?? ''));
		case 'list_sites':
			return sites(db);
		case 'get_site':
			return siteById(db, p, String(args.id ?? ''));
		case 'list_notifications':
			return notifications(db, p, qs(args));
		case 'ban_ip':
			return createDecision(
				db,
				p,
				{
					action: args.type ?? 'ban',
					ip: args.ip,
					duration: args.duration,
					reason: args.reason
				},
				'mcp'
			);
		case 'unban_ip':
			return removeDecision(db, p, { id: args.id, value: args.value }, 'mcp');
		default:
			throw new ApiError(400, `Unknown tool: ${name}`);
	}
}

const ok = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id: unknown, code: number, message: string) => ({
	jsonrpc: '2.0',
	id,
	error: { code, message }
});

async function handleRpc(
	p: ApiPrincipal,
	msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
): Promise<object | null> {
	const { id, method } = msg;
	// Notifications have no id — acknowledge with no response body content.
	if (id === undefined || id === null) return null;

	switch (method) {
		case 'initialize': {
			// Negotiate: answer the client's version when we speak it, else
			// our latest (the spec's fallback for unknown versions).
			const requested = String(
				(msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion ?? ''
			);
			return ok(id, {
				protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'bitdoze-crowdsec-dash', version: APP_VERSION },
				instructions:
					'CrowdSec management dashboard. Read tools always work; ban_ip/unban_ip need an operate-scope key.'
			});
		}
		case 'ping':
			return ok(id, {});
		case 'tools/list':
			return ok(id, { tools: TOOLS });
		case 'tools/call': {
			const params = msg.params ?? {};
			const name = String(params.name ?? '');
			const args =
				params.arguments && typeof params.arguments === 'object'
					? (params.arguments as Record<string, unknown>)
					: {};
			try {
				const result = await callTool(p, name, args);
				return ok(id, {
					content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
					isError: false
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return ok(id, { content: [{ type: 'text', text: message }], isError: true });
			}
		}
		default:
			return rpcErr(id, -32601, `Method not supported: ${method}`);
	}
}

export const POST: RequestHandler = async (event) => {
	// DNS-rebinding defense: a page on another origin must not be able to
	// POST here just because a permissive local resolver points at us.
	const origin = event.request.headers.get('origin');
	if (origin) {
		let bad: boolean;
		try {
			// config.origin is verbatim env — may carry a trailing slash.
			bad = new URL(origin).origin !== new URL(config.origin).origin;
		} catch {
			bad = true;
		}
		if (bad) return jsonErr(403, 'Origin not allowed.');
	}

	const auth = await apiAuth(event);
	if ('response' in auth) return auth.response;

	const tooBig = bodyTooBig(event);
	if (tooBig) return tooBig;
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return jsonErr(400, 'Expected a JSON-RPC body.');
	}
	const messages = Array.isArray(body) ? body : [body];
	if (messages.length === 0) return jsonErr(400, 'Empty batch.');
	if (messages.some((m) => !m || typeof m !== 'object' || m.jsonrpc !== '2.0'))
		return jsonErr(400, 'Every message must be JSON-RPC 2.0.');

	const replies = (await Promise.all(messages.map((m) => handleRpc(auth.principal, m)))).filter(
		(r): r is object => r !== null
	);

	if (replies.length === 0) return new Response(null, { status: 202 });
	// Echo the negotiated version when the client's header is one we speak.
	const reqVer = event.request.headers.get('mcp-protocol-version') ?? '';
	const version = SUPPORTED_VERSIONS.includes(reqVer) ? reqVer : PROTOCOL_VERSION;
	return Response.json(Array.isArray(body) ? replies : replies[0], {
		headers: { 'mcp-protocol-version': version, 'cache-control': 'no-store' }
	});
};

/**
 * Streamable HTTP requires GET to answer with text/event-stream or 405 —
 * we serve no SSE streams, so an SSE-asking client gets a clean 405.
 * Other GETs get a discovery document.
 */
export const GET: RequestHandler = ({ request }) => {
	if ((request.headers.get('accept') ?? '').includes('text/event-stream')) {
		return new Response(null, { status: 405, headers: { allow: 'POST' } });
	}
	return Response.json({
		name: 'bitdoze-crowdsec-dash MCP endpoint',
		transport: 'streamable-http (JSON responses; POST only)',
		auth: 'Authorization: Bearer csd_… — create keys under Settings → API keys',
		protocolVersion: PROTOCOL_VERSION,
		tools: TOOLS.map((t) => t.name)
	});
};
