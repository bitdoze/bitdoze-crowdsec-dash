# Agent API & MCP

The dashboard exposes a machine surface for AI agents and automation: a small
REST API under `/api/v1` and a [Model Context Protocol](https://modelcontextprotocol.io)
endpoint at `/mcp`. Both are authenticated by the same per-user API keys.

## API keys

Create one at **Settings → API keys**. The raw key (`csd_…`) is shown exactly
once — only its sha256 is stored.

- **Scopes:** `read` covers all GET endpoints; `operate` additionally allows
  ban/unban. There is no `configure` scope — user management, key minting, and
  Cloudflare account changes stay UI-only.
- **Role cap:** a key's effective scope never exceeds its owner's role. A
  viewer's `operate` key behaves as `read`; demoting an operator demotes
  their keys automatically. Banned/deleted users' keys die immediately.
- **Limits:** 25 active keys per user; 120 req/min per key (30/min per IP
  when unauthenticated), in-memory fixed window.

```sh
curl -H "Authorization: Bearer csd_…" https://dash.example.com/api/v1/status
```

`GET /api/v1` is unauthenticated and returns a machine-readable discovery
document (endpoints, scopes, MCP pointer).

## REST endpoints

| Endpoint                          | Notes                                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/v1/status`              | version, LAPI connectivity, per-source sync freshness                     |
| `GET /api/v1/alerts`              | `?siteId` `?scenario` `?ip` `?sinceHours` `?page`                         |
| `GET /api/v1/alerts/:id`          | one alert by upstream id                                                  |
| `GET /api/v1/decisions`           | `?q` `?includeExpired` `?page`                                            |
| `POST /api/v1/decisions`          | `{action:"ban"\|"captcha", ip\|cidr, duration, reason?}` — `operate`      |
| `DELETE /api/v1/decisions`        | `{id}` — request removal (value resolved from the projection) — `operate` |
| `GET /api/v1/sites` / `sites/:id` | inventory                                                                 |
| `GET /api/v1/lookup/:ip`          | alerts + decisions + geo for one address                                  |
| `GET /api/v1/notifications`       | `?limit` inbox rows                                                       |

Decision writes go through the same `decision_request` → LAPI → reconcile
pipeline as the UI — a `200` means _requested_, not _enforced_; the decision
appears in the projection on the next sync. API-originated mutations land in
the audit log (`via: "api"` or `"mcp"`) and fan out to the notification inbox
exactly like UI-initiated ones.

Errors are `{"error": "…"}` with 400/401/403/404/409/429/502 as appropriate.

## MCP (Streamable HTTP)

`POST /mcp` speaks JSON-RPC 2.0 with plain JSON responses (no SSE — every
reply is a direct answer, which the spec permits). Batches are supported.
`initialize`, `ping`, `tools/list`, `tools/call`, and `notifications/*` are
handled; `MCP-Protocol-Version` is echoed back negotiated. `GET /mcp`
returns a discovery document.

Tools: `status`, `list_alerts`, `get_alert`, `list_decisions`, `lookup_ip`,
`list_sites`, `get_site`, `list_notifications`, `ban_ip` (operate),
`unban_ip` (operate). Tool failures come back as `isError: true` results —
including scope denials.

### Client config

Any MCP client that supports a streamable-HTTP transport with headers works:

```jsonc
// .mcp.json (Claude Code) / equivalent
{
	"mcpServers": {
		"crowdsec-dash": {
			"type": "http",
			"url": "https://dash.example.com/mcp",
			"headers": { "Authorization": "Bearer csd_…" }
		}
	}
}
```

Example session:

```sh
curl -s -X POST https://dash.example.com/mcp \
  -H "Authorization: Bearer csd_…" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_decisions","arguments":{"q":"198.51.100.0"}}}'
```

## Threat model

- Keys are bearer credentials — serve the dashboard over HTTPS and keep
  `TRUSTED_PROXIES` correct so `lastUsedAt`/logs carry honest IPs.
- A leaked read key discloses the projection (alert IPs, hostnames) — treat
  it as semi-sensitive and rotate via Settings.
- The API writes nothing except `decision_request` rows; destructive host
  changes (agent ops, Cloudflare) remain UI-gated behind `configure`.
