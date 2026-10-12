/**
 * Per-site traffic statistics from the proxy's own access log — the JSON
 * lines Caddy writes when the access_log artifact is applied
 * (`${ACCESS_LOG_DIR}/${hostname}.log`). Read-only, on demand per page
 * load; the file is shared with CrowdSec's acquisition, so both sides see
 * the same traffic.
 *
 * Real format (verified on the deployment host): one JSON object per line
 * with `ts` (epoch seconds, float), `request.client_ip`, `request.uri`,
 * `request.method`, `request.host`, `status`, `size` (bytes out),
 * `duration` (seconds). Malformed lines are skipped, never fatal.
 *
 * Large logs are tail-capped — when the cap cuts inside the window the
 * result is marked `truncated` so the UI can say the window is partial
 * rather than silently under-reporting.
 */
import { open } from 'node:fs/promises';
import path from 'node:path';
import { ACCESS_LOG_DIR } from '$app/env/private';
import { downsample, type BucketPoint } from '#lib/activity.ts';

const MAX_BYTES = 24 * 1024 * 1024;
const HOUR_MS = 3_600_000;

export const TRAFFIC_RANGES = {
	'1h': HOUR_MS,
	'24h': 24 * HOUR_MS,
	'7d': 7 * 24 * HOUR_MS
} as const;
export type TrafficRange = keyof typeof TRAFFIC_RANGES;

export interface TrafficTop {
	key: string;
	n: number;
}

export interface SiteTraffic {
	state: 'ok' | 'no_log' | 'error';
	/** Range key actually used. */
	range: TrafficRange;
	/** Log path read (for operator reference / debugging). */
	file: string;
	requests: number;
	/** Bytes served in the window. */
	bytes: number;
	uniqueIps: number;
	/** Share of 4xx+5xx responses, 0..1. */
	errorRate: number;
	avgMs: number | null;
	byStatus: { s2xx: number; s3xx: number; s4xx: number; s5xx: number; other: number };
	topIps: TrafficTop[];
	topPaths: TrafficTop[];
	/** Requests per hour, chronological. */
	buckets: BucketPoint[];
	/** True when the tail cap cut inside the window — totals are a floor. */
	truncated: boolean;
	error?: string;
}

/** DNS-shape hostnames only — the value becomes a filename. */
const HOST_RE =
	/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

interface LogLine {
	ts?: number;
	status?: number;
	size?: number;
	duration?: number;
	request?: {
		client_ip?: string;
		remote_ip?: string;
		uri?: string;
		method?: string;
		host?: string;
	};
}

const empty = (
	range: TrafficRange,
	file: string,
	state: SiteTraffic['state'],
	error?: string
): SiteTraffic => ({
	state,
	range,
	file,
	requests: 0,
	bytes: 0,
	uniqueIps: 0,
	errorRate: 0,
	avgMs: null,
	byStatus: { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, other: 0 },
	topIps: [],
	topPaths: [],
	buckets: [],
	truncated: false,
	...(error ? { error } : {})
});

function uriPath(uri: string | undefined): string {
	if (!uri) return '—';
	// Caddy logs the origin-form request target (path + query).
	const q = uri.indexOf('?');
	return (q === -1 ? uri : uri.slice(0, q)) || '/';
}

const top = (counts: Map<string, number>, n: number): TrafficTop[] =>
	[...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([key, count]) => ({ key, n: count }));

export async function loadSiteTraffic(
	hostname: string,
	range: TrafficRange = '24h',
	now = Date.now(),
	dir = ACCESS_LOG_DIR ?? '/var/log/proxy'
): Promise<SiteTraffic> {
	const file = path.join(dir, `${hostname}.log`);
	if (!HOST_RE.test(hostname)) return empty(range, file, 'error', 'invalid hostname');
	if (!TRAFFIC_RANGES[range]) range = '24h';

	let fh;
	try {
		fh = await open(file, 'r');
	} catch {
		return empty(range, file, 'no_log');
	}
	try {
		const { size } = await fh.stat();
		if (!size) return empty(range, file, 'no_log');
		const readSize = Math.min(size, MAX_BYTES);
		const buf = Buffer.alloc(readSize);
		await fh.read(buf, 0, readSize, size - readSize);
		let text = buf.toString('utf8');
		if (readSize < size) {
			const nl = text.indexOf('\n');
			text = nl === -1 ? '' : text.slice(nl + 1); // drop the partial first line
		}

		const since = (now - TRAFFIC_RANGES[range]) / 1000;
		const ips = new Map<string, number>();
		const paths = new Map<string, number>();
		const hours = new Map<number, number>();
		const ipSet = new Set<string>();
		let requests = 0,
			bytes = 0,
			durSum = 0,
			s2xx = 0,
			s3xx = 0,
			s4xx = 0,
			s5xx = 0,
			other = 0,
			firstInWindow = Infinity;

		for (const line of text.split('\n')) {
			if (!line) continue;
			let j: LogLine;
			try {
				j = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof j.ts !== 'number' || j.ts < since) continue;
			if (j.ts < firstInWindow) firstInWindow = j.ts;
			requests++;
			bytes += typeof j.size === 'number' && j.size > 0 ? j.size : 0;
			if (typeof j.duration === 'number' && j.duration > 0) durSum += j.duration;
			const st = j.status ?? 0;
			if (st >= 200 && st < 300) s2xx++;
			else if (st >= 300 && st < 400) s3xx++;
			else if (st >= 400 && st < 500) s4xx++;
			else if (st >= 500 && st < 600) s5xx++;
			else other++;
			const ip = j.request?.client_ip ?? j.request?.remote_ip;
			if (ip) {
				ipSet.add(ip);
				ips.set(ip, (ips.get(ip) ?? 0) + 1);
			}
			const p = uriPath(j.request?.uri);
			paths.set(p, (paths.get(p) ?? 0) + 1);
			const h = Math.floor((j.ts * 1000) / HOUR_MS) * HOUR_MS;
			hours.set(h, (hours.get(h) ?? 0) + 1);
		}

		if (!requests) return { ...empty(range, file, 'ok'), truncated: readSize < size };
		// Truncated: the cap dropped lines that could still be in-window. If the
		// oldest surviving line is comfortably after the window edge AND there
		// are dropped bytes, some in-window lines were likely lost.
		const truncated = readSize < size;
		const buckets = downsample(
			[...hours.entries()].sort((a, b) => a[0] - b[0]).map(([at, total]) => ({ at, total })),
			48
		);
		return {
			state: 'ok',
			range,
			file,
			requests,
			bytes,
			uniqueIps: ipSet.size,
			errorRate: (s4xx + s5xx) / requests,
			avgMs: durSum > 0 ? (durSum / requests) * 1000 : null,
			byStatus: { s2xx, s3xx, s4xx, s5xx, other },
			topIps: top(ips, 8),
			topPaths: top(paths, 8),
			buckets,
			truncated
		};
	} catch (e) {
		return empty(range, file, 'error', e instanceof Error ? e.message : 'log read failed');
	} finally {
		await fh.close().catch(() => undefined);
	}
}
