import type { RequestHandler } from './$types';
import { APP_VERSION } from '#lib/server/ops.ts';

/**
 * API discovery — intentionally unauthenticated: an agent can always learn
 * the surface, every endpoint below still requires a Bearer key.
 */
export const GET: RequestHandler = () =>
	Response.json({
		name: 'bitdoze-crowdsec-dash',
		version: APP_VERSION,
		auth: 'Authorization: Bearer csd_… — create keys under Settings → API keys',
		scopes: {
			read: 'GET endpoints',
			operate: 'read + POST/DELETE /api/v1/decisions'
		},
		mcp: 'POST /mcp — same Bearer auth, tools/list + tools/call',
		endpoints: {
			'GET /api/v1/status': 'version, LAPI connectivity, sync freshness',
			'GET /api/v1/alerts': '?siteId &scenario &ip &sinceHours &page',
			'GET /api/v1/alerts/:id': 'one stored alert by upstream id',
			'GET /api/v1/decisions': '?q &includeExpired &page',
			'POST /api/v1/decisions': '{action:"ban"|"captcha", ip|cidr, duration, reason?}',
			'DELETE /api/v1/decisions': '{id, value} — request removal',
			'GET /api/v1/sites': 'inventory',
			'GET /api/v1/sites/:id': 'one site',
			'GET /api/v1/lookup/:ip': 'alerts + decisions + geo for an address',
			'GET /api/v1/notifications': '?limit — inbox rows'
		}
	});
