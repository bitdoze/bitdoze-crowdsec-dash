import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	ORIGIN: {
		description:
			'The public origin (base URL) of the app, e.g. `https://dash.example.com`. Used as the Better Auth baseURL and to pin the request origin in server/index.js. Required in production.',
		schema: (value) => value ?? 'http://localhost:5173'
	},
	DATA_DIR: {
		description: 'Directory holding the SQLite database, generated secrets, and other app data.',
		schema: (value) => value ?? './data'
	},
	DATABASE_URL: {
		description: 'libSQL connection string. Defaults to `file:${DATA_DIR}/app.db` when unset.',
		schema: (value) => value
	},
	BETTER_AUTH_SECRET: {
		description:
			'Secret used to sign auth tokens. Optional: when unset, one is generated and persisted under DATA_DIR/secrets/. `BETTER_AUTH_SECRET_FILE` may point to a file containing the secret instead.',
		schema: (value) => value
	},
	SETUP_TOKEN: {
		description:
			'Optional fixed token for first-run administrator setup. When unset and no users exist, a one-time token is generated at startup and logged once.',
		schema: (value) => value
	},
	MIGRATIONS_DIR: {
		description: 'Directory with drizzle-kit migrations, applied at startup.',
		schema: (value) => value ?? './drizzle'
	},
	TRUSTED_PROXIES: {
		description:
			'Comma-separated reverse-proxy IPs allowed to supply x-forwarded-for, or `*` when the process is only reachable through a proxy. Unset = the socket address is always the client IP. Read by server/index.js.',
		schema: (value) => value
	},
	DEMO_FIXTURES: {
		description:
			'Set to `true` to serve clearly labeled fixture data on the overview outside development (e2e, reviews). Dev mode always enables fixtures. Never set in real deployments.',
		schema: (value) => value
	},
	AGENT_SOCKET: {
		description:
			'Unix socket path of the optional host agent (tier D). Unset = agent features unavailable.',
		schema: (value) => value
	},
	AGENT_TOKEN: {
		description:
			'Shared token the dashboard presents to the host agent on connect. `AGENT_TOKEN_FILE` may point to a file containing it instead.',
		schema: (value) => value
	}
});
