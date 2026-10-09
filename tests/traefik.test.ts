import { describe, expect, it } from 'vitest';
import {
	bypasses,
	discoverTraefik,
	matchSite,
	parseDockerPs,
	ruleHostnames
} from '#lib/server/protect/traefik.ts';

const PS_FIXTURE = `
{"Command":"traefik --providers.docker=true --experimental.plugins.crowdsec-bouncer.modulename=github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin","ID":"a1","Image":"traefik:v3.4","Labels":"","Names":"traefik","Networks":"proxy","Ports":"0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp","State":"running"}
{"Command":"/docker-entrypoint.sh crowdsec","ID":"b2","Image":"crowdsecurity/crowdsec:latest","Labels":"","Names":"crowdsec","Networks":"proxy","Ports":"","State":"running"}
{"Command":"whoami","ID":"c3","Image":"traefik/whoami:latest","Labels":"traefik.enable=true,traefik.http.routers.blog.rule=Host(\`blog.example.com\`),traefik.http.routers.blog.middlewares=crowdsec-blog@file","Names":"blog","Networks":"proxy","Ports":"","State":"running"}
{"Command":"whoami","ID":"d4","Image":"traefik/whoami:latest","Labels":"traefik.enable=true,traefik.http.routers.admin.rule=Host(\`admin.example.com\`)","Names":"admin","Networks":"proxy","Ports":"0.0.0.0:8080->80/tcp","State":"running"}
{"Command":"postgres","ID":"e5","Image":"postgres:16","Labels":"","Names":"db","Networks":"internal","Ports":"5432/tcp","State":"running"}
not-json
`;

describe('parseDockerPs', () => {
	it('parses JSONL into containers, skipping bad lines', () => {
		const containers = parseDockerPs(PS_FIXTURE);
		expect(containers).toHaveLength(5);
		expect(containers[0].name).toBe('traefik');
	});

	it('splits label and port strings into structured fields', () => {
		const [traefik, , blog] = parseDockerPs(PS_FIXTURE);
		expect(traefik.ports).toContain('0.0.0.0:443->443/tcp');
		expect(blog.labels['traefik.http.routers.blog.rule']).toContain('blog.example.com');
		expect(blog.networks).toEqual(['proxy']);
	});

	it('handles empty output', () => {
		expect(parseDockerPs('')).toEqual([]);
	});
});

describe('ruleHostnames', () => {
	it('extracts every Host() matcher', () => {
		expect(
			ruleHostnames('Host(`a.example.com`) || Host(`www.a.example.com`) && PathPrefix(`/`)')
		).toEqual(['a.example.com', 'www.a.example.com']);
	});
	it('ignores non-Host rules', () => {
		expect(ruleHostnames('PathPrefix(`/api`)')).toEqual([]);
	});
});

describe('discoverTraefik', () => {
	const d = discoverTraefik(parseDockerPs(PS_FIXTURE));

	it('finds traefik and crowdsec containers', () => {
		expect(d.traefik?.container).toBe('traefik');
		expect(d.traefik?.bouncerPlugin).toBe(true);
		expect(d.crowdsec?.container).toBe('crowdsec');
	});

	it('maps router labels to apps with hostnames and middlewares', () => {
		expect(d.apps).toHaveLength(2);
		const blog = matchSite(d, 'blog.example.com');
		expect(blog?.container).toBe('blog');
		expect(blog?.router).toBe('blog');
		expect(blog?.middlewares).toEqual(['crowdsec-blog@file']);
		expect(blog?.publishedPorts).toEqual([]);
	});

	it('flags published host ports as bypasses', () => {
		expect(bypasses(d).map((a) => a.router)).toEqual(['admin']);
		expect(bypasses(d)[0].publishedPorts).toEqual(['0.0.0.0:8080->80/tcp']);
	});

	it('reports honestly when nothing is found', () => {
		const empty = discoverTraefik(parseDockerPs('{"Names":"x","Image":"redis"}'));
		expect(empty.traefik).toBeNull();
		expect(empty.crowdsec).toBeNull();
		expect(empty.apps).toEqual([]);
	});
});
