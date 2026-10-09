#!/usr/bin/env node
/**
 * Bitdoze CrowdSec Dash host agent — the only component allowed to touch
 * privileged host state (spec §10, tier D). Deployed separately from the
 * web container; it may hold the Docker socket or local cscli access, the
 * dashboard never does.
 *
 * Protocol: newline-delimited JSON over a unix socket. First frame after
 * connect must be {"token": AGENT_TOKEN}; then {"id", op, params} frames get
 * {"id", ok, result} or {"id", ok:false, error:{code,message}} replies.
 *
 * Configuration (all env):
 *   AGENT_SOCKET      unix socket path          (default /run/bitdoze-agent.sock)
 *   AGENT_TOKEN       shared auth token          (required)
 *   AGENT_CSCLI       'local' | 'docker:<ctr>'   (unset = cscli ops disabled)
 *   AGENT_FILE_ROOTS  colon-separated writable roots (unset = file ops denied)
 *   AGENT_BACKUP_DIR  where file.backup lands    (default <socket dir>/backups)
 *   AGENT_SERVICES    comma-separated 'systemd:unit' / 'docker:ctr' reload targets
 *   AGENT_DOCKER      '1' enables read-only docker ps/inspect ops
 *                     (default: on when AGENT_CSCLI is docker:<container>)
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	unlinkSync,
	statSync,
	copyFileSync,
	readFileSync,
	chmodSync
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const SOCKET = process.env.AGENT_SOCKET || '/run/bitdoze-agent.sock';
const TOKEN = process.env.AGENT_TOKEN || '';
const CSCLI_MODE = process.env.AGENT_CSCLI || ''; // 'local' | 'docker:<container>'
const FILE_ROOTS = (process.env.AGENT_FILE_ROOTS || '')
	.split(':')
	.map((r) => r.trim())
	.filter(Boolean)
	.map((r) => resolve(r) + sep);
const BACKUP_DIR = process.env.AGENT_BACKUP_DIR || resolve(dirname(SOCKET), 'backups');
const SERVICES = new Set(
	(process.env.AGENT_SERVICES || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
);
const MAX_OUT = 512 * 1024;
const MAX_FRAME = 4 * 1024 * 1024;
const EXEC_TIMEOUT = 30_000;
const VERSION = '0.5.0';
const PROTOCOL = 1;
// Read-only docker discovery is opt-in — implicit only when the cscli
// bridge already execs into a container (socket is clearly present).
const DOCKER = process.env.AGENT_DOCKER === '1' || CSCLI_MODE.startsWith('docker:');

if (!TOKEN) {
	console.error('AGENT_TOKEN is required — refusing to listen unauthenticated');
	process.exit(1);
}

/** Strip credential-looking values from anything shown back to callers. */
function redact(text) {
	return String(text)
		.replace(
			/((?:key|token|password|secret|authorization)[\s"':=]+)[^\s"',}\]]{4,}/gi,
			'$1[redacted]'
		)
		.replace(/(bearer\s+)[^\s"',}]{4,}/gi, '$1[redacted]');
}

function err(code, message) {
	return { ok: false, error: { code, message: redact(message).slice(0, 2000) } };
}

/**
 * Spawn without a shell — argv is built solely from validated, whitelisted
 * values; nothing from a request is ever interpolated into a command line.
 */
function run(bin, args, { input, timeout = EXEC_TIMEOUT } = {}) {
	return new Promise((resolveRun) => {
		let out = '';
		let child;
		try {
			child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (e) {
			resolveRun(err('exec', `spawn ${bin}: ${e.message}`));
			return;
		}
		const kill = setTimeout(() => {
			child.kill('SIGKILL');
		}, timeout);
		child.stdout.on('data', (c) => {
			if (out.length < MAX_OUT) out += c;
		});
		child.stderr.on('data', (c) => {
			if (out.length < MAX_OUT) out += c;
		});
		child.on('error', (e) => {
			clearTimeout(kill);
			resolveRun(err('exec', `${bin}: ${e.message}`));
		});
		child.on('close', (code) => {
			clearTimeout(kill);
			if (out.length >= MAX_OUT) out += '\n[output truncated at 512KiB]';
			if (code === 0) resolveRun({ ok: true, result: { output: redact(out) } });
			else resolveRun(err('exec', `${bin} exited ${code}: ${out.slice(-2000)}`));
		});
		if (input !== undefined) {
			child.stdin.write(input);
			child.stdin.end();
		}
	});
}

/** cscli argv prefix per deployment mode — the only two ways to reach it. */
function cscliBase() {
	if (CSCLI_MODE === 'local') return { bin: 'cscli', args: [] };
	if (CSCLI_MODE.startsWith('docker:')) {
		const container = CSCLI_MODE.slice(7);
		if (!/^[a-zA-Z0-9_.-]+$/.test(container)) return null;
		return { bin: 'docker', args: ['exec', container, 'cscli'] };
	}
	return null;
}

function cscli(args, opts) {
	const base = cscliBase();
	if (!base)
		return Promise.resolve(err('unavailable', 'cscli bridge not configured (AGENT_CSCLI)'));
	return run(base.bin, [...base.args, ...args], opts);
}

const HUB_ITEM = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IP_OR_CIDR =
	/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$|^(\d{1,3}\.){3}\d{1,3}$/;
const SIM_SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const LOG_TYPE = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;

/** File ops stay under declared roots — absolute, normalized, no escapes. */
function scopedPath(p) {
	if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) return null;
	const norm = resolve(p);
	if (!FILE_ROOTS.some((root) => norm.startsWith(root))) return null;
	return norm;
}

function jsonOut(r) {
	if (!r.ok) return r;
	try {
		return { ok: true, result: JSON.parse(r.result.output) };
	} catch {
		return { ok: true, result: { output: r.result.output } };
	}
}

/** Serialize mutating ops — hub/allowlist/simulation/config writes. */
let writeLock = Promise.resolve();
const serial = (fn) => {
	const p = writeLock.then(fn, fn);
	writeLock = p.then(
		() => undefined,
		() => undefined
	);
	return p;
};

const OPS = {
	hello: async () => ({
		ok: true,
		result: {
			protocol: PROTOCOL,
			version: VERSION,
			caps: {
				cscli: !!cscliBase(),
				cscliMode: CSCLI_MODE || null,
				docker: DOCKER,
				files: FILE_ROOTS.length > 0,
				roots: FILE_ROOTS.map((r) => r.slice(0, -1)),
				services: [...SERVICES]
			}
		}
	}),

	// ---- tier-D read ops -----------------------------------------------------
	'bouncers.list': () => cscli(['bouncers', 'list', '-o', 'json']).then(jsonOut),
	'machines.list': () => cscli(['machines', 'list', '-o', 'json']).then(jsonOut),
	'hub.list': () => cscli(['hub', 'list', '-o', 'json']).then(jsonOut),
	'allowlists.list': () => cscli(['allowlists', 'list', '-o', 'json']).then(jsonOut),
	'simulation.status': () => cscli(['simulation', 'status', '-o', 'json']).then(jsonOut),
	'setup.detect': () =>
		cscli(['setup', 'detect'], { timeout: 60_000 }).then((r) =>
			r.ok ? { ok: true, result: { output: r.result.output.slice(0, 64 * 1024) } } : r
		),
	explain: (p) => {
		if (!p || typeof p.line !== 'string' || !p.line.trim())
			return err('invalid', 'explain needs {line}');
		if (!LOG_TYPE.test(p.type || ''))
			return err('invalid', 'explain needs a log {type} like caddy-syslog or nginx');
		return cscli(['explain', '--log', p.line.slice(0, 4096), '--type', p.type], {
			timeout: 60_000
		}).then((r) =>
			r.ok ? { ok: true, result: { output: r.result.output.slice(0, 64 * 1024) } } : r
		);
	},

	// ---- read-only docker discovery (AGENT_DOCKER) ---------------------------
	'docker.ps': () => {
		if (!DOCKER) return err('unavailable', 'docker ops not enabled (AGENT_DOCKER)');
		// One JSON object per line — parsed dashboard-side.
		return run('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}']).then((r) =>
			r.ok ? { ok: true, result: { output: r.result.output.slice(0, 512 * 1024) } } : r
		);
	},
	'docker.inspect': (p) => {
		if (!DOCKER) return err('unavailable', 'docker ops not enabled (AGENT_DOCKER)');
		if (!p || !CONTAINER.test(p.name || '')) return err('invalid', 'docker.inspect needs {name}');
		return run('docker', ['inspect', '--type', 'container', p.name]).then((r) =>
			r.ok ? { ok: true, result: { output: r.result.output.slice(0, 512 * 1024) } } : r
		);
	},

	// ---- tier-D write ops (serialized) --------------------------------------
	'hub.install': (p) => {
		const type = p?.type;
		if (!['collections', 'parsers', 'scenarios', 'contexts', 'appsec-rules'].includes(type))
			return err(
				'invalid',
				'hub.install needs {type: collections|parsers|scenarios|contexts|appsec-rules}'
			);
		if (!p || !HUB_ITEM.test(p.item || '')) return err('invalid', 'invalid hub item name');
		return serial(() => cscli([type, 'install', p.item]));
	},
	'hub.update': () => serial(() => cscli(['hub', 'update'])),
	'allowlist.add': async (p) => {
		if (!p || !NAME.test(p.name || '') || !Array.isArray(p.values) || !p.values.length)
			return err('invalid', 'need {name, values[]}');
		if (p.values.length > 64 || !p.values.every((v) => typeof v === 'string' && IP_OR_CIDR.test(v)))
			return err('invalid', 'values must be valid IPs/CIDRs (max 64)');
		return serial(async () => {
			const desc = typeof p.description === 'string' ? p.description.slice(0, 200) : '';
			const create = await cscli(['allowlists', 'create', p.name, '-d', desc]);
			// already-exists is fine — adding values is the idempotent part
			if (!create.ok && !/exist/i.test(create.error.message)) return create;
			return cscli(['allowlists', 'add', p.name, ...p.values]);
		});
	},
	'allowlist.remove': (p) => {
		if (!p || !NAME.test(p.name || '') || !IP_OR_CIDR.test(p.value || ''))
			return err('invalid', 'need {name, value}');
		return serial(() => cscli(['allowlists', 'remove', p.name, p.value]));
	},
	'simulation.set': (p) => {
		const args = ['simulation', p?.enabled ? 'enable' : 'disable'];
		if (p?.scope) {
			if (!SIM_SCOPE.test(p.scope)) return err('invalid', 'invalid simulation scope');
			args.push(p.scope);
		}
		return serial(() => cscli(args));
	},

	/**
	 * Issue a bouncer API key. If the name exists it is deleted and re-issued —
	 * a key is unrecoverable after creation, so recreation is the only
	 * idempotent answer. The result carries the key: callers must treat it as
	 * a secret and never write it into logs or job detail.
	 */
	'bouncers.add': (p) => {
		if (!p || !NAME.test(p.name || '')) return err('invalid', 'need {name}');
		return serial(async () => {
			const add = await cscli(['bouncers', 'add', p.name, '-o', 'raw']);
			if (add.ok) return { ok: true, result: { name: p.name, key: add.result.output.trim() } };
			if (!/exist/i.test(add.error.message)) return add;
			const del = await cscli(['bouncers', 'delete', p.name]);
			if (!del.ok) return del;
			const again = await cscli(['bouncers', 'add', p.name, '-o', 'raw']);
			if (!again.ok) return again;
			return { ok: true, result: { name: p.name, key: again.result.output.trim() } };
		});
	},

	// ---- scoped file ops -----------------------------------------------------
	'file.read': (p) => {
		const path = scopedPath(p?.path);
		if (!path) return err('denied', 'path is outside the allowed roots');
		try {
			const st = statSync(path);
			if (!st.isFile() || st.size > 1024 * 1024) return err('invalid', 'not a file or too large');
			return { ok: true, result: { path, content: readFileSync(path, 'utf8') } };
		} catch (e) {
			return err('exec', e.message);
		}
	},
	'file.write': (p) => {
		const path = scopedPath(p?.path);
		if (!path) return err('denied', 'path is outside the allowed roots');
		if (typeof p?.content !== 'string' || p.content.length > 256 * 1024)
			return err('invalid', 'content must be a string ≤256KiB');
		return serial(async () => {
			try {
				mkdirSync(dirname(path), { recursive: true });
				await writeFile(path, p.content, 'utf8');
				return { ok: true, result: { path, bytes: p.content.length } };
			} catch (e) {
				return err('exec', e.message);
			}
		});
	},
	'file.backup': (p) => {
		const path = scopedPath(p?.path);
		if (!path) return err('denied', 'path is outside the allowed roots');
		return serial(async () => {
			try {
				if (!existsSync(path)) return { ok: true, result: { path, backup: null } };
				mkdirSync(BACKUP_DIR, { recursive: true });
				const backup = resolve(
					BACKUP_DIR,
					`${path.replaceAll(sep, '_')}.${new Date().toISOString().replaceAll(':', '-')}.bak`
				);
				copyFileSync(path, backup);
				return { ok: true, result: { path, backup } };
			} catch (e) {
				return err('exec', e.message);
			}
		});
	},
	'file.restore': (p) => {
		// Restores only from files the agent itself wrote into BACKUP_DIR.
		const backup = typeof p?.backup === 'string' ? resolve(p.backup) : null;
		const path = scopedPath(p?.path);
		if (!path) return err('denied', 'path is outside the allowed roots');
		if (!backup || !backup.startsWith(resolve(BACKUP_DIR) + sep))
			return err('denied', 'backup is outside the backup dir');
		return serial(async () => {
			try {
				copyFileSync(backup, path);
				return { ok: true, result: { path, backup } };
			} catch (e) {
				return err('exec', e.message);
			}
		});
	},

	// ---- scoped reloads ------------------------------------------------------
	'service.reload': (p) => {
		const target = p?.target;
		if (typeof target !== 'string' || !SERVICES.has(target))
			return err('denied', 'target is not in AGENT_SERVICES');
		return serial(() => {
			const [kind, name] = target.split(':');
			if (kind === 'systemd') return run('systemctl', ['reload-or-restart', name]);
			if (kind === 'docker') return run('docker', ['kill', '-s', 'HUP', name]);
			return err('invalid', 'service targets look like systemd:<unit> or docker:<container>');
		});
	}
};

const server = createServer((conn) => {
	let authed = false;
	let buf = '';
	const authTimer = setTimeout(() => {
		if (!authed) conn.destroy();
	}, 5000);

	conn.on('data', (chunk) => {
		buf += chunk;
		if (buf.length > MAX_FRAME) {
			conn.destroy();
			return;
		}
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				conn.write(
					JSON.stringify({ id: null, ok: false, error: { code: 'invalid', message: 'bad json' } }) +
						'\n'
				);
				continue;
			}
			if (!authed) {
				if (msg.token === TOKEN) {
					authed = true;
					clearTimeout(authTimer);
					conn.write(
						JSON.stringify({ id: msg.id ?? null, ok: true, result: { protocol: PROTOCOL } }) + '\n'
					);
				} else {
					conn.destroy();
					return;
				}
				continue;
			}
			const reply = (r) =>
				conn.write(JSON.stringify({ id: msg.id ?? null, ...r }).slice(0, MAX_FRAME) + '\n');
			const op = OPS[msg.op];
			if (!op) {
				reply(err('invalid', `unknown op ${JSON.stringify(msg.op)}`));
				continue;
			}
			Promise.resolve()
				.then(() => op(msg.params ?? {}))
				.then(reply)
				.catch((e) => reply(err('exec', e.message || String(e))));
		}
	});
});

try {
	unlinkSync(SOCKET);
} catch {
	/* absent */
}
mkdirSync(dirname(SOCKET), { recursive: true });
server.listen(SOCKET, () => {
	// Owner+group only — the socket itself is an auth boundary alongside the token.
	chmodSync(SOCKET, 0o660);
	console.log(`agent on ${SOCKET} (protocol ${PROTOCOL})`);
});
