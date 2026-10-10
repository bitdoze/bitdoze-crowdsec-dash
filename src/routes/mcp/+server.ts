/**
 * MCP endpoint — Streamable HTTP, JSON-only responses (no SSE: every reply
 * is a direct answer to the request, which the spec permits).
 *
 * Auth: the same `Authorization: Bearer csd_…` API key as /api/v1; tool
 * scopes mirror REST — `operate` keys may ban/unban, everything else is read.
 *
 * Supported methods: initialize, ping, notifications/*, tools/list,
 * tools/call. `MCP-Protocol-Version` is echoed back negotiated.
 */
import type { RequestHandler } from './$types';
import { apiAuth, jsonErr } from '#lib/server/api/http.ts';
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

const PROTOCOL_VERSION = '2025-06-18';

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
			duration: { type: 'string', description: 'e.g. 4h, 90m, 2d (max 30d)' },
			reason: { type: 'string' },
			type: { type: 'string', enum: ['ban', 'captcha'] }
		},
		['ip', 'duration']
	),
	tool(
		'unban_ip',
		'Request removal of an active decision. Needs an operate-scope key.',
		{
			id: { type: 'number' },
			value: { type: 'string', description: 'The decision value (IP/CIDR)' }
		},
		['id', 'value']
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
			return createDecision(db, p, {
				action: args.type ?? 'ban',
				ip: args.ip,
				duration: args.duration,
				reason: args.reason
			});
		case 'unban_ip':
			return removeDecision(db, p, { id: args.id, value: args.value });
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
	msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> },
	protocolVersion: string
): Promise<object | null> {
	const { id, method } = msg;
	// Notifications have no id — acknowledge with no response body content.
	if (id === undefined || id === null) return null;

	switch (method) {
		case 'initialize':
			return ok(id, {
				protocolVersion,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'bitdoze-crowdsec-dash', version: APP_VERSION },
				instructions:
					'CrowdSec management dashboard. Read tools always work; ban_ip/unban_ip need an operate-scope key.'
			});
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
	const auth = await apiAuth(event);
	if ('response' in auth) return auth.response;

	const protocolVersion = event.request.headers.get('mcp-protocol-version') ?? PROTOCOL_VERSION;
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

	const replies = (
		await Promise.all(messages.map((m) => handleRpc(auth.principal, m, protocolVersion)))
	).filter((r): r is object => r !== null);

	if (replies.length === 0) return new Response(null, { status: 202 });
	return Response.json(Array.isArray(body) ? replies : replies[0], {
		headers: { 'mcp-protocol-version': protocolVersion }
	});
};

/** Discovery-friendly GET: what this endpoint is and how to authenticate. */
export const GET: RequestHandler = () =>
	Response.json({
		name: 'bitdoze-crowdsec-dash MCP endpoint',
		transport: 'streamable-http (JSON responses; POST only)',
		auth: 'Authorization: Bearer csd_… — create keys under Settings → API keys',
		protocolVersion: PROTOCOL_VERSION,
		tools: TOOLS.map((t) => t.name)
	});
