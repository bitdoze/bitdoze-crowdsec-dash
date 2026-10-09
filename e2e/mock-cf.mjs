/**
 * Mock Cloudflare API v4 for e2e runs — token verify, zones, account IP
 * lists (CRUD + bulk ops that complete immediately), and zone custom
 * rulesets. Accepts only `Bearer e2e-cf-token`; `/_state` dumps the
 * store for assertions, `/_fail` flips API calls to 500s.
 */
import { createServer } from 'node:http';

const TOKEN = 'e2e-cf-token';
const ACCOUNT = 'acct-e2e';

const state = {
	zones: [
		{
			id: 'zone-a',
			name: 'e2e-cf.example.com',
			status: 'active',
			plan: { name: 'Free Website' },
			account: { id: ACCOUNT, name: 'E2E Account' }
		},
		{
			id: 'zone-b',
			name: 'other.example.org',
			status: 'active',
			plan: { name: 'Free Website' },
			account: { id: ACCOUNT, name: 'E2E Account' }
		}
	],
	/** listId -> { id, name, kind, description, items: Map<ip, comment> } */
	lists: new Map(),
	/** zoneId -> rules array */
	rulesets: new Map(),
	ops: new Map(),
	nextId: 1,
	fail: false
};

function ok(res, result) {
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ success: true, errors: [], messages: [], result }));
}
function err(res, code, status = 400) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(
		JSON.stringify({
			success: false,
			errors: [{ code, message: `mock error ${code}` }],
			messages: []
		})
	);
}
const readBody = (req) =>
	new Promise((r) => {
		let b = '';
		req.on('data', (c) => (b += c));
		req.on('end', () => r(b));
	});

const server = createServer(async (req, res) => {
	const url = new URL(req.url, 'http://x');

	if (url.pathname === '/_state')
		return ok(res, {
			lists: [...state.lists.values()].map((l) => ({
				id: l.id,
				name: l.name,
				kind: l.kind,
				items: [...l.items.keys()]
			})),
			rulesets: Object.fromEntries(state.rulesets)
		});
	if (url.pathname === '/_fail') {
		state.fail = url.searchParams.get('set') === '1';
		return ok(res, { fail: state.fail });
	}
	if (url.pathname === '/_reset') {
		state.lists.clear();
		state.rulesets.clear();
		state.ops.clear();
		return ok(res, { reset: true });
	}
	if (state.fail) return err(res, 10000, 500);
	if (req.headers.authorization !== `Bearer ${TOKEN}`) return err(res, 9109, 403);

	// Token verification
	if (url.pathname === '/user/tokens/verify') {
		return ok(res, {
			id: 'tok-e2e',
			name: 'e2e edge token',
			status: 'active',
			policies: [
				{
					effect: 'allow',
					resources: { 'com.cloudflare.api.account': ACCOUNT },
					permission_groups: [
						{ name: 'Account Filter Lists Edit' },
						{ name: 'Zone WAF Edit' },
						{ name: 'Zone Read' }
					]
				}
			]
		});
	}

	// Zones
	if (url.pathname === '/zones' && req.method === 'GET') return ok(res, state.zones);

	// Zone custom-rules entrypoint
	const rulesetMatch =
		/^\/zones\/([^/]+)\/rulesets\/phases\/http_request_firewall_custom\/entrypoint$/.exec(
			url.pathname
		);
	if (rulesetMatch) {
		const zoneId = rulesetMatch[1];
		if (req.method === 'GET') {
			const rules = state.rulesets.get(zoneId);
			if (!rules) return err(res, 10002, 404);
			return ok(res, { id: `rs-${zoneId}`, rules });
		}
		if (req.method === 'PUT') {
			const body = JSON.parse((await readBody(req)) || '{}');
			const rules = (body.rules ?? []).map((r) => ({
				id: `rule-${state.nextId++}`,
				enabled: true,
				...r
			}));
			state.rulesets.set(zoneId, rules);
			return ok(res, { id: `rs-${zoneId}`, rules });
		}
	}

	// Account lists
	const listsMatch = /^\/accounts\/([^/]+)\/rules\/lists\/?(.*)$/.exec(url.pathname);
	if (listsMatch) {
		const [, accountId, tail] = listsMatch;
		if (accountId !== ACCOUNT) return err(res, 7003, 404);
		if (!tail && req.method === 'GET') {
			return ok(
				res,
				[...state.lists.values()].map((l) => ({
					id: l.id,
					name: l.name,
					kind: l.kind,
					description: l.description,
					num_items: l.items.size,
					num_referencing_filters: 0
				}))
			);
		}
		if (!tail && req.method === 'POST') {
			const body = JSON.parse((await readBody(req)) || '{}');
			const id = `list-${state.nextId++}`;
			state.lists.set(id, {
				id,
				name: body.name,
				kind: body.kind,
				description: body.description,
				items: new Map()
			});
			return ok(res, { id, name: body.name, kind: body.kind, description: body.description });
		}
		const delMatch = /^([a-z0-9-]+)$/.exec(tail);
		if (delMatch && req.method === 'DELETE') {
			state.lists.delete(delMatch[1]);
			return ok(res, { deleted: true });
		}
		const itemsMatch = /^([a-z0-9-]+)\/items$/.exec(tail);
		if (itemsMatch) {
			const list = state.lists.get(itemsMatch[1]);
			if (!list) return err(res, 7003, 404);
			if (req.method === 'GET') {
				return res.writeHead(200, { 'Content-Type': 'application/json' }).end(
					JSON.stringify({
						success: true,
						errors: [],
						messages: [],
						result: [...list.items.entries()].map(([ip, comment]) => ({ ip, comment })),
						result_info: {}
					})
				);
			}
			if (req.method === 'PUT') {
				const body = JSON.parse((await readBody(req)) || '{}');
				for (const item of body.add ?? []) list.items.set(item.ip, item.comment ?? '');
				for (const item of body.remove ?? []) list.items.delete(item.ip);
				const opId = `op-${state.nextId++}`;
				state.ops.set(opId, 'completed');
				return ok(res, { operation_id: opId });
			}
		}
		const opMatch = /^([a-z0-9-]+)\/bulk_operations\/([a-z0-9-]+)$/.exec(tail);
		if (opMatch && req.method === 'GET') {
			const status = state.ops.get(opMatch[2]);
			if (!status) return err(res, 7003, 404);
			return ok(res, { id: opMatch[2], status, completed: new Date().toISOString() });
		}
	}

	err(res, 7000, 404);
});

server.listen(8091, '127.0.0.1', () => console.log('mock Cloudflare API on :8091'));
