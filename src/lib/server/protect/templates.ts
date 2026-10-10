/**
 * Per-proxy guided configuration artifacts (spec 6.1/6.2). Everything here is
 * pure string generation — the dashboard never applies these itself; the
 * administrator copies them and the artifacts stay `not_applied` until a
 * verification check passes.
 */
import { createHash } from 'node:crypto';
import { WAF_LEVELS } from '#lib/sites.ts';

export type ProxyKind = 'caddy' | 'traefik' | 'nginx' | 'other' | 'unknown';
export type Runtime = 'native' | 'docker' | 'unknown';

export type PlanInput = {
	hostname: string;
	proxy: ProxyKind;
	runtime: Runtime;
	cloudflare: boolean;
	/** LAPI URL the bouncer should reach (e.g. http://crowdsec:8080). */
	lapiUrl: string;
	/** Directory CrowdSec can read access logs from. */
	logDir: string;
	/**
	 * Traefik file-provider directory on the host — middleware files written
	 * here are picked up live (watch: true). Defaults to /etc/traefik/dynamic.
	 */
	dynamicDir?: string;
	/**
	 * Directory holding proxy-side managed files — Caddy snippets import from
	 * here, nginx conf.d files land here. Defaults: /etc/caddy/crowdsec,
	 * /etc/nginx/conf.d. Stored per-site after adoption/discovery.
	 */
	confDir?: string;
	/**
	 * WAF protection level 1–4 from spec §5.5; 'off' omits the AppSec
	 * artifact entirely. Defaults to '1' (virtual patching only).
	 */
	wafLevel?: 'off' | '1' | '2' | '3' | '4';
	/** Remediation profile preset (spec §5.7). Defaults to 'escalating'. */
	remediationPreset?: 'flat' | 'escalating' | 'captcha';
	/**
	 * Per-site AppSec exclusion collections (e.g. crowdsecurity/appsec-wordpress)
	 * — installed alongside the level collections so app-specific false
	 * positives are tuned out. Validated against the hub item name shape.
	 */
	appsecExclusions?: string[];
};

export type Artifact = {
	kind:
		| 'access_log'
		| 'acquisition'
		| 'collections'
		| 'real_ip'
		| 'bouncer'
		| 'middleware'
		| 'appsec'
		| 'remediation'
		| 'compose'
		| 'demo';
	title: string;
	format: 'yaml' | 'caddyfile' | 'nginx' | 'toml' | 'shell' | 'compose';
	content: string;
};

export const TEST_PATH = '/crowdsec-test-NtktlJHV4TfBSK3wvlhiOBnl';
export const TEST_SCENARIO = 'crowdsecurity/http-generic-test';
export const APPSEC_TEST_RULE = 'crowdsecurity/appsec-generic-test';

export function artifactHash(content: string): string {
	return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Desired-vs-observed drift hash. The desired content may carry a
 * `<bouncer-key>` placeholder while the applied file holds the issued key —
 * both sides normalize credential values to a marker so a substituted key
 * doesn't count as drift (its value is never stored or compared).
 */
const KEY_VALUE =
	/(<bouncer-key>|API_KEY=\S+|api_key\s+\S+|api_key:\s*\S+|crowdsec_lapi_key\s*=\s*\S+)/g;

export function driftHash(content: string): string {
	return createHash('sha256')
		.update(content.replace(KEY_VALUE, '<key>'))
		.digest('hex')
		.slice(0, 12);
}

/** CrowdSec acquis snippet for a file source, docker source, or journald. */
function acquisition(input: PlanInput): Artifact {
	const logPath = `${input.logDir}/${input.hostname}.log`;
	const content =
		input.runtime === 'docker'
			? `# /etc/crowdsec/acquis.d/${input.hostname}.yaml
# Reads the proxy container's own log file, bind-mounted so it survives
# container recreation. No Docker socket access needed.
filenames:
  - ${logPath}
labels:
  type: ${input.proxy}
  # target_fqdn links alerts to ${input.hostname} in this dashboard.
  target_fqdn: ${input.hostname}
`
			: `# /etc/crowdsec/acquis.d/${input.hostname}.yaml
filenames:
  - ${logPath}
labels:
  type: ${input.proxy}
  target_fqdn: ${input.hostname}
`;
	return {
		kind: 'acquisition',
		title: `CrowdSec acquisition for ${input.hostname}`,
		format: 'yaml',
		content
	};
}

function collections(input: PlanInput): Artifact {
	const proxyCollection = {
		caddy: 'crowdsecurity/caddy',
		traefik: 'crowdsecurity/traefik',
		nginx: 'crowdsecurity/nginx',
		other: 'crowdsecurity/base-http-scenarios',
		unknown: 'crowdsecurity/base-http-scenarios'
	}[input.proxy];
	return {
		kind: 'collections',
		title: 'Hub collections to install',
		format: 'shell',
		content: `# Install the parser + scenario collections matching this proxy, plus
# http_extended so alert context carries the target host for attribution.
cscli collections install ${proxyCollection}
cscli collections install crowdsecurity/base-http-scenarios
cscli parsers install crowdsecurity/http-logs
${wafCollections(input.wafLevel)}${exclusionCollections(input.appsecExclusions)}# Enables richer event context (target_fqdn) used for site attribution:
cscli hub update && cscli collections upgrade crowdsecurity/${input.proxy === 'unknown' ? 'base-http-scenarios' : input.proxy === 'other' ? 'base-http-scenarios' : input.proxy}
sudo systemctl reload crowdsec  # or: docker restart crowdsec
`
	};
}

/**
 * AppSec configs per WAF level (spec §5.5). Level 3 runs CRS out-of-band —
 * matches surface as alerts without blocking, which is the gate evidence a
 * site needs before moving to level 4 (in-band CRS).
 */
export const WAF_CONFIGS: Record<'1' | '2' | '3' | '4', string[]> = {
	'1': ['crowdsecurity/appsec-default', 'crowdsecurity/virtual-patching'],
	'2': [
		'crowdsecurity/appsec-default',
		'crowdsecurity/virtual-patching',
		'crowdsecurity/appsec-generic-rules'
	],
	'3': [
		'crowdsecurity/appsec-default',
		'crowdsecurity/virtual-patching',
		'crowdsecurity/appsec-generic-rules',
		'crowdsecurity/appsec-crs'
	],
	'4': [
		'crowdsecurity/appsec-default',
		'crowdsecurity/virtual-patching',
		'crowdsecurity/appsec-generic-rules',
		'crowdsecurity/appsec-crs-inband'
	]
};

/** Extra `cscli collections install` lines the level needs. */
function wafCollections(level: PlanInput['wafLevel']): string {
	if (!level || level === 'off' || level === '1') return '';
	const items =
		level === '2'
			? ['crowdsecurity/appsec-generic-rules']
			: level === '3'
				? ['crowdsecurity/appsec-generic-rules', 'crowdsecurity/appsec-crs']
				: ['crowdsecurity/appsec-generic-rules', 'crowdsecurity/appsec-crs-inband'];
	return items.map((i) => `cscli collections install ${i}`).join('\n') + '\n';
}

/** Per-site exclusion collections — app-specific false-positive tuning. */
function exclusionCollections(items: string[] | undefined): string {
	if (!items?.length) return '';
	return items.map((i) => `cscli collections install ${i}`).join('\n') + '\n';
}

function appsecConfigYaml(input: PlanInput): string {
	const level = input.wafLevel === 'off' ? '1' : (input.wafLevel ?? '1');
	return WAF_CONFIGS[level].map((c) => `  - ${c}`).join('\n');
}

function remediation(input: PlanInput): Artifact {
	const preset = input.remediationPreset ?? 'escalating';
	const blocks: Record<string, { title: string; yaml: string }> = {
		flat: {
			title: 'Remediation profile — flat 4h bans',
			yaml: `name: dashboard_default_ip_remediation
filters:
  - Alert.Remediation == true && Alert.GetScope() == "Ip"
decisions:
  - type: ban
    duration: 4h
on_success: break`
		},
		escalating: {
			title: 'Remediation profile — escalating bans for repeat offenders',
			yaml: `name: dashboard_default_ip_remediation
filters:
  - Alert.Remediation == true && Alert.GetScope() == "Ip"
decisions:
  - type: ban
    duration: 4h
    duration_expr: Sprintf('%dh', (GetDecisionsCount(Alert.GetValue()) + 1) * 4)
on_success: break`
		},
		captcha: {
			title: 'Remediation profile — captcha for low-confidence scenarios',
			yaml: `# Low-confidence probing scenarios challenge instead of banning —
# requires bouncers that support captcha remediation.
name: dashboard_captcha_ip_remediation
filters:
  - Alert.Remediation == true && Alert.GetScope() == "Ip" &&
    Alert.GetScenario() in ["crowdsecurity/http-probing", "crowdsecurity/http-crawl-non_statics"]
decisions:
  - type: captcha
    duration: 4h
on_success: break
---
# Everything else still gets the escalating ban.
name: dashboard_default_ip_remediation
filters:
  - Alert.Remediation == true && Alert.GetScope() == "Ip"
decisions:
  - type: ban
    duration: 4h
    duration_expr: Sprintf('%dh', (GetDecisionsCount(Alert.GetValue()) + 1) * 4)
on_success: break`
		}
	};
	const b = blocks[preset] ?? blocks.escalating;
	return {
		kind: 'remediation',
		title: `${b.title} (profiles.yaml)`,
		format: 'yaml',
		content: `# /etc/crowdsec/profiles.yaml — managed block. Merges with, never
# replaces, your existing profiles. Keep the default block last.
${b.yaml}
`
	};
}

/* ---------------------------------- Caddy ---------------------------------- */

/** Cloudflare published ranges (keep current: https://www.cloudflare.com/ips/). */
const CF_CIDRS = [
	'173.245.48.0/20',
	'103.21.244.0/22',
	'103.22.200.0/22',
	'103.31.4.0/22',
	'141.101.64.0/18',
	'108.162.192.0/18',
	'190.93.240.0/20',
	'188.114.96.0/20',
	'197.234.240.0/22',
	'198.41.128.0/17',
	'162.158.0.0/15',
	'104.16.0.0/13',
	'104.24.0.0/14',
	'172.64.0.0/13',
	'131.0.72.0/22'
];

function caddy(input: PlanInput): Artifact[] {
	const logPath = `${input.logDir}/${input.hostname}.log`;
	const slug = input.hostname.replace(/[^a-z0-9]/g, '-');
	const confDir = input.confDir ?? '/etc/caddy/crowdsec';
	// Snippets live in /etc/caddy/crowdsec/ — new files only, never edited
	// into the existing Caddyfile. The admin adds one `import` line inside
	// the site block; `caddy validate` resolves imports, so a managed apply
	// can validate before reloading.
	const accessLog: Artifact = {
		kind: 'access_log',
		title: `Caddyfile — CrowdSec handler + JSON access log for ${input.hostname}`,
		format: 'caddyfile',
		content: `# ${confDir}/${slug}.caddy
# Per-site file — add one line inside the site's Caddyfile block:
#     import ${confDir}/${slug}.caddy
crowdsec   # its LAPI settings live in crowdsec-global.caddy
log {
	output file ${logPath}
	format json
}
`
	};
	const realIp: Artifact = {
		kind: 'real_ip',
		title: 'Caddyfile — trusted proxies for real client IPs (global options)',
		format: 'caddyfile',
		content: `# ${confDir}/crowdsec-realip.caddy
# \`servers\` is a GLOBAL option — import this inside the global options
# block at the top of your Caddyfile, never inside a site block:
#     {
#         import ${confDir}/crowdsec-realip.caddy
#     }
servers {
	trusted_proxies static ${input.cloudflare ? CF_CIDRS.join(' ') : 'private_ranges'}
${input.cloudflare ? '\tclient_ip_headers CF-Connecting-IP\n' : ''}}
`
	};
	const bouncer: Artifact = {
		kind: 'bouncer',
		title: 'Caddyfile — CrowdSec bouncer (global options)',
		format: 'caddyfile',
		content: `# ${confDir}/crowdsec-global.caddy
# Shared by every site on this Caddy instance — import it inside the
# global options block at the top of your Caddyfile, not inside a site
# block:
#     {
#         import ${confDir}/crowdsec-global.caddy
#     }
# The stock caddy image does NOT ship the bouncer — use the pinned build in
# the Compose artifact.
order crowdsec first
crowdsec {
	api_url ${input.lapiUrl}
	api_key <bouncer-key>   # issued by the managed apply job
	# appsec_url http://crowdsec:7422   # uncomment for inline WAF
}
`
	};
	const appsec: Artifact = {
		kind: 'appsec',
		title: 'AppSec component + forwarding',
		format: 'yaml',
		content: `# /etc/crowdsec/appsec.yaml — virtualhost-based AppSec (WAF) service.
# WAF level ${input.wafLevel === 'off' ? '1' : (input.wafLevel ?? '1')} — ${WAF_LEVELS.find((l) => l.value === (input.wafLevel === 'off' ? '1' : (input.wafLevel ?? '1')))?.label}.
appsec_configs:
${appsecConfigYaml(input)}
listen_addr: 0.0.0.0:7422
# Then uncomment appsec_url in the bouncer snippet so Caddy forwards
# requests for inspection before serving them.
`
	};
	const compose: Artifact | null =
		input.runtime === 'docker'
			? {
					kind: 'compose',
					title: 'Compose — pinned Caddy build with the CrowdSec module',
					format: 'compose',
					content: `services:
  caddy:
    # Pinned custom build — the stock caddy image lacks the bouncer module.
    build:
      dockerfile_inline: |
        FROM caddy:2-builder AS builder
        RUN xcaddy build \\
            --with github.com/hslatman/caddy-crowdsec-bouncer/http@v0.14.1 \\
            --with github.com/hslatman/caddy-crowdsec-bouncer/appsec@v0.14.1
        FROM caddy:2
        COPY --from=builder /usr/bin/caddy /usr/bin/caddy
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./crowdsec:/etc/caddy/crowdsec:ro   # managed snippets import from here
      - ${input.logDir}:${input.logDir}   # share access logs with CrowdSec
    networks: [proxy]
`
				}
			: null;
	return [
		accessLog,
		realIp,
		bouncer,
		appsec,
		acquisition(input),
		collections(input),
		remediation(input),
		...(compose ? [compose] : [])
	];
}

/* ---------------------------------- Traefik --------------------------------- */

function traefik(input: PlanInput): Artifact[] {
	const accessLog: Artifact = {
		kind: 'access_log',
		title: 'Traefik static config — JSON access logs',
		format: 'yaml',
		content: `# traefik.yaml (static config) — access logs are OFF by default.
accessLog:
  filePath: ${input.logDir}/traefik-access.log
  format: json
  fields:
    headers:
      names:
        User-Agent: keep
`
	};
	const realIp: Artifact = {
		kind: 'real_ip',
		title: 'Traefik — trusted entry-point proxies',
		format: 'yaml',
		content: `entryPoints:
  websecure:
    address: :443
    forwardedHeaders:
      # Trust X-Forwarded-For only from these ranges.
      trustedIPs:
${input.cloudflare ? '        # Cloudflare published ranges — keep current (https://www.cloudflare.com/ips/).\n        - "173.245.48.0/20"\n        - "103.21.244.0/22"\n        - "103.22.200.0/22"\n        - "103.31.4.0/22"\n        - "141.101.64.0/18"\n        - "108.162.192.0/18"\n        - "190.93.240.0/20"\n        - "188.114.96.0/20"\n        - "197.234.240.0/22"\n        - "198.41.128.0/17"\n        - "162.158.0.0/15"\n        - "104.16.0.0/13"\n        - "104.24.0.0/14"\n        - "172.64.0.0/13"\n        - "131.0.72.0/22"' : '        - "10.0.0.0/8"\n        - "172.16.0.0/12"\n        - "192.168.0.0/16"'}
`
	};
	const routerName = input.hostname.replace(/[^a-z0-9]/g, '-');
	const bouncer: Artifact = {
		kind: 'bouncer',
		title: 'Traefik static config — bouncer plugin + file provider',
		format: 'yaml',
		content: `# traefik.yaml (static config) — needs a Traefik restart.
experimental:
  plugins:
    crowdsec-bouncer:
      moduleName: github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin
      version: v1.7.1
providers:
  file:
    directory: ${input.dynamicDir ?? '/etc/traefik/dynamic'}
    watch: true    # the middleware artifact below reloads live from here
`
	};
	const middleware: Artifact = {
		kind: 'middleware',
		title: `Traefik dynamic middleware file for ${input.hostname}`,
		format: 'yaml',
		// Complete file — managed apply writes it and Traefik reloads live.
		content: `# ${input.dynamicDir ?? '/etc/traefik/dynamic'}/crowdsec-${routerName}.yaml
# The file provider watches this directory — no Traefik restart needed.
http:
  middlewares:
    crowdsec-${routerName}:
      plugin:
        crowdsec-bouncer:
          enabled: true
          crowdsecLapiKey: <bouncer-key>   # issued by the managed apply job
          crowdsecLapiHost: ${input.lapiUrl.replace(/^https?:\/\//, '')}
          crowdsecMode: stream
          forwardedHeadersTrustedIPs:
${(input.cloudflare ? CF_CIDRS : ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'])
	.map((c) => `            - "${c}"`)
	.join('\n')}
          # crowdsecAppsecEnabled: true    # uncomment for inline WAF
  routers:
    ${routerName}:
      rule: Host(\`${input.hostname}\`)
      middlewares: [crowdsec-${routerName}]
#   ^ With the docker provider the router usually lives on the app's
#     container labels instead — then attach by label instead:
#     traefik.http.routers.${routerName}.middlewares=crowdsec-${routerName}
`
	};
	const appsec: Artifact = {
		kind: 'appsec',
		title: 'AppSec acquisition + forwarding',
		format: 'yaml',
		content: `# /etc/crowdsec/appsec.yaml — WAF level ${input.wafLevel === 'off' ? '1' : (input.wafLevel ?? '1')}.
appsec_configs:
${appsecConfigYaml(input)}
listen_addr: 0.0.0.0:7422
# Then set crowdsecAppsecEnabled: true and crowdsecAppsecHost in the
# middleware so Traefik forwards requests for inspection.
`
	};
	const compose: Artifact | null =
		input.runtime === 'docker'
			? {
					kind: 'compose',
					title: "Compose labels — middleware on this service's router",
					format: 'compose',
					content: `services:
  app:
    labels:
      - "traefik.http.routers.${routerName}.middlewares=crowdsec-${routerName}"
      # Opt the container's logs into CrowdSec acquisition:
      - "crowdsec.enable=true"
      - "crowdsec.labels.type=traefik"
`
				}
			: null;
	const demo: Artifact | null = input.runtime === 'docker' ? traefikDemo(input, routerName) : null;
	return [
		accessLog,
		realIp,
		bouncer,
		middleware,
		appsec,
		acquisition(input),
		collections(input),
		remediation(input),
		...(compose ? [compose] : []),
		...(demo ? [demo] : [])
	];
}

/**
 * A standalone demonstration stack (spec 7): traefik with the bouncer plugin
 * and file provider, CrowdSec with acquis + collections, and one labeled demo
 * app routed on this site's hostname. Guided — deploying a stack is the
 * administrator's decision.
 */
function traefikDemo(input: PlanInput, routerName: string): Artifact {
	const dyn = input.dynamicDir ?? '/etc/traefik/dynamic';
	return {
		kind: 'demo',
		title: 'Demonstration stack — Traefik + CrowdSec + this site',
		format: 'compose',
		content: `# Guided only — run this in a scratch directory, not over production.
services:
  traefik:
    image: traefik:v3.4
    command:
      - --api.insecure=false
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.file.directory=${dyn}
      - --providers.file.watch=true
      - --entrypoints.web.address=:80
      - --accesslog=true
      - --accesslog.format=json
      - --accesslog.filepath=/logs/traefik-access.log
      - --experimental.plugins.crowdsec-bouncer.modulename=github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin
      - --experimental.plugins.crowdsec-bouncer.version=v1.7.1
    ports: ["80:80"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./dynamic:${dyn}
      - ./logs:/logs
  crowdsec:
    image: crowdsecurity/crowdsec:latest
    volumes:
      - ./crowdsec/acquis.yaml:/etc/crowdsec/acquis.yaml:ro
      - ./logs:/logs:ro
      - crowdsec-db:/var/lib/crowdsec/data
    environment:
      COLLECTIONS: crowdsecurity/traefik crowdsecurity/base-http-scenarios
      BOUNCER_KEY_DASH: changeme
  app:
    image: traefik/whoami:latest
    labels:
      - traefik.enable=true
      - traefik.http.routers.${routerName}.rule=Host(\`${input.hostname}\`)
      - traefik.http.routers.${routerName}.entrypoints=web
      - traefik.http.routers.${routerName}.middlewares=crowdsec-${routerName}
      - crowdsec.enable=true
      - crowdsec.labels.type=traefik
volumes:
  crowdsec-db:
`
	};
}

/* ---------------------------------- Nginx ---------------------------------- */

function nginx(input: PlanInput): Artifact[] {
	const logPath = `${input.logDir}/${input.hostname}.log`;
	const confDir = input.confDir ?? '/etc/nginx/conf.d';
	const accessLog: Artifact = {
		kind: 'access_log',
		title: 'nginx conf.d — crowdsec log format',
		format: 'nginx',
		// Complete conf.d file — included inside http{} on Debian/RHEL stock
		// configs. Only the log_format lives here: enforcement is the
		// bouncer package's job, and duplicating its lua blocks would break
		// nginx -t once the package is installed.
		content: `# ${confDir}/crowdsec-dash.conf
# Shared across sites — an http-context directive, so applying this
# artifact from any site writes the same file.
#
# Enforcement comes from the crowdsec-nginx-bouncer package — it ships
# its own /etc/nginx/conf.d/crowdsec_nginx.conf, so installing it is all
# the lua wiring you need:
#   apt install crowdsec-nginx-bouncer
#
# For OpenResty or manual installs, replicate the upstream block in one
# of YOUR http-context files (do NOT enable it here — duplicate
# init_by_lua_block directives fail nginx -t once the package lands):
#   lua_package_path '/usr/lib/crowdsec/lua/?.lua;;';
#   lua_shared_dict crowdsec_cache 50m;
#   init_by_lua_block {
#       cs = require "crowdsec"
#       local ok, err = cs.init("/etc/crowdsec/bouncers/crowdsec-nginx-bouncer.conf",
#           "crowdsec-nginx-bouncer/v1.2.3")
#   }
#   access_by_lua_block { cs.Allow(ngx.var.remote_addr) }
#   init_worker_by_lua_block { cs.SetupStream(); cs.SetupMetrics() }

# The default 'combined' format has no $host — attribution needs it.
log_format crowdsec '$host $remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent"';
# Then inside each site's server{} block (guided — do not add a server
# block here, it would shadow your site's routing):
#   access_log ${logPath} crowdsec;
`
	};
	const realIp: Artifact = {
		kind: 'real_ip',
		title: 'nginx — real client IP through the trusted chain',
		format: 'nginx',
		content: `# In the http{} block or this server{} — one line per trusted range.
${
	input.cloudflare
		? `# Cloudflare published ranges (keep current: https://www.cloudflare.com/ips/):
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
real_ip_header CF-Connecting-IP;`
		: `set_real_ip_from 10.0.0.0/8;
set_real_ip_from 172.16.0.0/12;
set_real_ip_from 192.168.0.0/16;
real_ip_header X-Forwarded-For;`
}
real_ip_recursive on;
`
	};
	const bouncer: Artifact = {
		kind: 'bouncer',
		title: 'cs-nginx-bouncer configuration file',
		format: 'shell',
		content: `# /etc/crowdsec/bouncers/crowdsec-nginx-bouncer.conf
# Complete file — the lua bouncer reads its LAPI credentials here.
# Install first: apt install crowdsec-nginx-bouncer (Debian package),
# or follow the OpenResty manual-install recipe.
#
# NOTE: the bouncer's config parser takes everything after the first
# '=' as the value — comments are only valid on their own lines.
ENABLED=true
API_URL=${input.lapiUrl}
# issued by the managed apply job
API_KEY=<bouncer-key>
CACHE_EXPIRATION=1
BOUNCING_ON_TYPE=all
FALLBACK_REMEDIATION=ban
REQUEST_TIMEOUT=3000
UPDATE_FREQUENCY=10
MODE=live
EXCLUDE_LOCATION=
BAN_TEMPLATE_PATH=/var/lib/crowdsec/lua/templates/ban.html
REDIRECT_LOCATION=
RET_CODE=
CAPTCHA_PROVIDER=
SECRET_KEY=
SITE_KEY=
CAPTCHA_TEMPLATE_PATH=/var/lib/crowdsec/lua/templates/captcha.html
CAPTCHA_EXPIRATION=3600
# Uncomment for inline WAF:
# APPSEC_URL=http://127.0.0.1:7422
`
	};
	const appsec: Artifact = {
		kind: 'appsec',
		title: 'AppSec service for nginx bouncer',
		format: 'yaml',
		content: `# /etc/crowdsec/appsec.yaml — WAF level ${input.wafLevel === 'off' ? '1' : (input.wafLevel ?? '1')}.
appsec_configs:
${appsecConfigYaml(input)}
listen_addr: 127.0.0.1:7422
# Then set APPSEC_URL in the bouncer config above and reload nginx.
`
	};
	const compose: Artifact | null =
		input.runtime === 'docker'
			? {
					kind: 'compose',
					title: 'Compose — nginx with the Lua bouncer',
					format: 'compose',
					content: `services:
  nginx:
    # Pick an image with the Lua module, or bind-mount config + bouncer lua
    # paths into the official image. conf.d and log dir shared:
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./conf.d:/etc/nginx/conf.d:ro
      - ./crowdsec-nginx-bouncer.conf:/etc/crowdsec/bouncers/crowdsec-nginx-bouncer.conf:ro
      - ${input.logDir}:${input.logDir}
`
				}
			: null;
	return [
		accessLog,
		realIp,
		bouncer,
		appsec,
		acquisition(input),
		collections(input),
		remediation(input),
		...(compose ? [compose] : [])
	];
}

/**
 * Build the full artifact set for a site. `unknown`/`other` proxies get the
 * generic pieces (acquisition, collections, remediation) plus a shell
 * artifact explaining which proxy answers are needed.
 */
export function generatePlan(input: PlanInput): Artifact[] {
	const arts =
		input.proxy === 'caddy'
			? caddy(input)
			: input.proxy === 'traefik'
				? traefik(input)
				: input.proxy === 'nginx'
					? nginx(input)
					: [
							{
								kind: 'access_log' as const,
								title: 'Tell us what fronts this site',
								format: 'shell' as const,
								content: `# No artifacts generated — set the site's proxy (Caddy, Traefik, or
# Nginx) on the site page or run Detect topology. Detection reads the
# public response headers, or you can answer directly.
`
							},
							acquisition(input),
							collections(input),
							remediation(input)
						];
	// WAF level 'off' — no AppSec artifact at all (spec §5.5: AppSec is
	// toggled independently of log detection).
	return input.wafLevel === 'off' ? arts.filter((a) => a.kind !== 'appsec') : arts;
}
