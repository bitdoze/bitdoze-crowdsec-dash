/**
 * Dashboard-side client for the host agent (tier D). NDJSON over a unix
 * socket, token-authenticated; a short-lived connection per call keeps the
 * protocol simple — ops are bounded to seconds, not streams.
 */
import { connect } from 'node:net';
import { AGENT_SOCKET, AGENT_TOKEN } from '$app/env/private';

export type AgentCaps = {
	protocol: number;
	version: string;
	caps: {
		cscli: boolean;
		cscliMode: string | null;
		files: boolean;
		roots: string[];
		services: string[];
	};
};

export type AgentReply<T = unknown> =
	{ ok: true; result: T } | { ok: false; error: { code: string; message: string } };

let nextId = 0;

/** One NDJSON request/response over a fresh socket connection. */
function roundTrip<T>(
	socket: string,
	token: string,
	op: string,
	params: unknown,
	timeoutMs: number
) {
	return new Promise<AgentReply<T>>((resolveCall) => {
		const conn = connect(socket);
		let buf = '';
		let authed = false;
		const id = ++nextId;
		const finish = (r: AgentReply<T>) => {
			conn.destroy();
			resolveCall(r);
		};
		const timer = setTimeout(
			() => finish({ ok: false, error: { code: 'timeout', message: 'agent call timed out' } }),
			timeoutMs
		);
		conn.on('error', (e) => {
			clearTimeout(timer);
			finish({ ok: false, error: { code: 'unavailable', message: e.message } });
		});
		conn.on('connect', () => {
			conn.write(JSON.stringify({ id: 0, token }) + '\n');
		});
		conn.on('data', (chunk) => {
			buf += chunk;
			let nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg: {
					id: number | null;
					ok: boolean;
					result?: T;
					error?: { code: string; message: string };
				};
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (!authed) {
					if (msg.ok) {
						authed = true;
						conn.write(JSON.stringify({ id, op, params }) + '\n');
					} else {
						clearTimeout(timer);
						finish({ ok: false, error: { code: 'auth', message: 'agent rejected the token' } });
					}
					continue;
				}
				if (msg.id === id) {
					clearTimeout(timer);
					finish(msg.ok ? { ok: true, result: msg.result as T } : { ok: false, error: msg.error! });
					return;
				}
			}
		});
		conn.on('close', () => {
			clearTimeout(timer);
			finish({ ok: false, error: { code: 'unavailable', message: 'agent socket closed' } });
		});
	});
}

export function agentConfigured(): boolean {
	return !!(AGENT_SOCKET && AGENT_TOKEN);
}

/** Call a typed agent op. Never throws — failures are `ok:false`. */
export function callAgent<T = unknown>(
	op: string,
	params: Record<string, unknown> = {},
	timeoutMs = 45_000
): Promise<AgentReply<T>> {
	if (!agentConfigured()) {
		return Promise.resolve({
			ok: false,
			error: { code: 'unavailable', message: 'no agent configured (AGENT_SOCKET/AGENT_TOKEN)' }
		});
	}
	return roundTrip<T>(AGENT_SOCKET!, AGENT_TOKEN!, op, params, timeoutMs);
}

let cachedHello: { at: number; hello: AgentCaps | null } = { at: 0, hello: null };

/**
 * Agent reachability + capability negotiation, cached for 15s so page loads
 * don't hammer the socket.
 */
export async function agentHello(force = false): Promise<AgentCaps | null> {
	if (!force && cachedHello.hello !== null && Date.now() - cachedHello.at < 15_000)
		return cachedHello.hello;
	const r = await callAgent<AgentCaps>('hello', {}, 5_000);
	cachedHello = { at: Date.now(), hello: r.ok ? r.result : null };
	return cachedHello.hello;
}
