/**
 * Traefik + Docker topology discovery (spec phase 7). Pure parsing of the
 * agent's `docker.ps` output — no agent calls happen here, so every branch is
 * unit-testable. `docker ps --format '{{json .}}'` emits one capitalized JSON
 * object per line.
 */
export type DockerContainer = {
	name: string;
	image: string;
	command: string;
	state: string;
	labels: Record<string, string>;
	/** Host-published "hostPort->containerPort" strings (empty when bridge-only). */
	ports: string[];
	networks: string[];
};

export type TraefikApp = {
	container: string;
	router: string;
	hostnames: string[];
	middlewares: string[];
	publishedPorts: string[];
	networks: string[];
};

export type TraefikDiscovery = {
	traefik: { container: string; image: string; bouncerPlugin: boolean } | null;
	crowdsec: { container: string; image: string } | null;
	/** Other known proxies seen in the inventory (caddy/nginx), for adoption hints. */
	proxies: { kind: 'caddy' | 'nginx'; container: string; image: string }[];
	apps: TraefikApp[];
	at: string;
};

/** Parse `docker ps --format '{{json .}}'` output — one object per line. */
export function parseDockerPs(output: string): DockerContainer[] {
	const out: DockerContainer[] = [];
	for (const line of output.split('\n')) {
		const t = line.trim();
		if (!t) continue;
		let row: Record<string, string>;
		try {
			row = JSON.parse(t);
		} catch {
			continue;
		}
		out.push({
			name: String(row.Names ?? row.Name ?? ''),
			image: String(row.Image ?? ''),
			command: String(row.Command ?? ''),
			state: String(row.State ?? ''),
			labels: parseKV(row.Labels),
			ports: (row.Ports ?? '')
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean),
			networks: (row.Networks ?? '')
				.split(',')
				.map((n) => n.trim())
				.filter(Boolean)
		});
	}
	return out;
}

function parseKV(s: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of (s ?? '').split(',')) {
		const eq = pair.indexOf('=');
		if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
	}
	return out;
}

/** `Host(`a`,`b`)` / `HostRegexp{...}` rules → plain hostnames. */
export function ruleHostnames(rule: string): string[] {
	return [...rule.matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1]);
}

const ROUTER = /^traefik\.http\.routers\.([^.]+)\.(rule|middlewares)$/;

/** Distill the container list into a Traefik topology for one host. */
export function discoverTraefik(containers: DockerContainer[]): TraefikDiscovery {
	let traefik: TraefikDiscovery['traefik'] = null;
	let crowdsec: TraefikDiscovery['crowdsec'] = null;
	const proxies: TraefikDiscovery['proxies'] = [];
	const apps = new Map<string, TraefikApp>();

	for (const c of containers) {
		const hay = `${c.image} ${c.command}`.toLowerCase();
		const isTraefik = /(^|[/:_-])traefik/.test(hay);
		// Phase 8: caddy/nginx containers are adoptable proxies too — flag
		// them by image name (traefik images contain "traefik" so order the
		// checks to keep them disjoint).
		if (!isTraefik && /(^|[/:_-])caddy/.test(hay))
			proxies.push({ kind: 'caddy', container: c.name, image: c.image });
		if (!isTraefik && /(^|[/:_-])(nginx|openresty)/.test(hay))
			proxies.push({ kind: 'nginx', container: c.name, image: c.image });
		if (!traefik && isTraefik) {
			traefik = {
				container: c.name,
				image: c.image,
				bouncerPlugin: /crowdsec/i.test(hay) || /experimental\.plugins/i.test(hay)
			};
		}
		// Traefik's own command line mentions the bouncer plugin — don't let it
		// pass as the CrowdSec engine container.
		if (!crowdsec && !isTraefik && /crowdsec/i.test(hay))
			crowdsec = { container: c.name, image: c.image };

		const routers = new Map<string, TraefikApp>();
		for (const [k, v] of Object.entries(c.labels)) {
			const m = ROUTER.exec(k);
			if (!m) continue;
			const [, router, field] = m;
			const app =
				routers.get(router) ??
				({
					container: c.name,
					router,
					hostnames: [],
					middlewares: [],
					publishedPorts: c.ports,
					networks: c.networks
				} satisfies TraefikApp);
			if (field === 'rule') app.hostnames = ruleHostnames(v);
			if (field === 'middlewares')
				app.middlewares = v
					.split(',')
					.map((x) => x.trim())
					.filter(Boolean);
			routers.set(router, app);
		}
		for (const app of routers.values()) apps.set(`${c.name}|${app.router}`, app);
	}

	return {
		traefik,
		crowdsec,
		proxies,
		apps: [...apps.values()],
		at: new Date().toISOString()
	};
}

/** The app router serving this site's hostname, if discovery saw one. */
export function matchSite(d: TraefikDiscovery, hostname: string): TraefikApp | null {
	return d.apps.find((a) => a.hostnames.includes(hostname)) ?? null;
}

/**
 * Direct-port bypass: a routed app also publishes its port on the host — the
 * proxy (and its bouncer/WAF) can be skipped entirely.
 */
export function bypasses(d: TraefikDiscovery): TraefikApp[] {
	return d.apps.filter((a) => a.publishedPorts.length > 0);
}
