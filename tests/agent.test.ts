/**
 * Host-agent protocol tests — spawns the real server/agent.js against a tmp
 * unix socket with stub cscli/docker binaries on PATH. Covers auth, op
 * allowlisting, input validation, path scoping, and serialized writes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_DIR, AGENT_SOCKET, AGENT_TOKEN } from './mocks/app-env-private.ts';

const FILE_ROOT = join(AGENT_DIR, 'files');
const BIN_DIR = join(AGENT_DIR, 'bin');
const CALLS_LOG = join(AGENT_DIR, 'calls.log');

let agent: ChildProcess;

/** Minimal NDJSON client matching the dashboard protocol. */
function call(
	op: string | undefined,
	params: unknown = {},
	token = AGENT_TOKEN
): Promise<{
	ok: boolean;
	result?: {
		caps?: { cscli: boolean; docker: boolean; files: boolean; services: string[] };
		backup?: string | null;
		key?: string;
		output?: string;
		[key: string]: unknown;
	};
	error?: { code: string; message: string };
}> {
	return new Promise((resolveCall, reject) => {
		const conn = connect(AGENT_SOCKET!);
		let buf = '';
		let authed = false;
		conn.on('error', reject);
		conn.on('connect', () => conn.write(JSON.stringify({ id: 0, token }) + '\n'));
		conn.on('data', (chunk) => {
			buf += chunk;
			let nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				const msg = JSON.parse(line);
				if (!authed) {
					authed = true;
					if (msg.ok) conn.write(JSON.stringify({ id: 1, op, params }) + '\n');
					else {
						conn.destroy();
						resolveCall(msg);
					}
					continue;
				}
				conn.destroy();
				resolveCall(msg);
			}
		});
		conn.on('close', () => reject(new Error('socket closed before reply')));
	});
}

const calls = () =>
	existsSync(CALLS_LOG) ? readFileSync(CALLS_LOG, 'utf8').trim().split('\n') : [];

beforeAll(async () => {
	mkdirSync(FILE_ROOT, { recursive: true });
	mkdirSync(BIN_DIR, { recursive: true });
	// Stub cscli — logs argv, answers `-o json` list ops with canned JSON,
	// `bouncers add` with a deterministic key.
	writeFileSync(
		join(BIN_DIR, 'cscli'),
		[
			'#!/bin/sh',
			`echo "cscli $*" >> ${CALLS_LOG}`,
			'case "$1 $2" in',
			'  "bouncers add") echo "TEST-KEY-9f8e7d6c5b";;',
			'  "bouncers delete") ;;',
			'  *) for a in "$@"; do if [ "$a" = "-o" ]; then echo \'[{"stub":true}]\'; exit 0; fi; done;;',
			'esac',
			'exit 0'
		].join('\n')
	);
	writeFileSync(
		join(BIN_DIR, 'docker'),
		[
			'#!/bin/sh',
			`echo "docker $*" >> ${CALLS_LOG}`,
			'case "$1" in',
			'  "ps") cat "${DOCKER_PS_FIXTURE:-/dev/null}";;',
			'  "inspect") echo \'[{"Id":"stub"}]\';;',
			'esac',
			'exit 0'
		].join('\n')
	);
	chmodSync(join(BIN_DIR, 'cscli'), 0o755);
	chmodSync(join(BIN_DIR, 'docker'), 0o755);

	writeFileSync(
		join(AGENT_DIR, 'ps.jsonl'),
		[
			'{"Command":"traefik --providers.docker=true","Names":"traefik","Image":"traefik:v3.4","Labels":"","Networks":"proxy","Ports":"0.0.0.0:443->443/tcp","State":"running"}',
			'{"Command":"whoami","Names":"blog","Image":"traefik/whoami","Labels":"traefik.enable=true,traefik.http.routers.blog.rule=Host(`blog.test`)","Networks":"proxy","Ports":"","State":"running"}'
		].join('\n')
	);
	agent = spawn(process.execPath, ['server/agent.js'], {
		env: {
			...process.env,
			AGENT_SOCKET: AGENT_SOCKET!,
			AGENT_TOKEN: AGENT_TOKEN!,
			AGENT_CSCLI: 'local',
			AGENT_DOCKER: '1',
			AGENT_FILE_ROOTS: FILE_ROOT,
			AGENT_SERVICES: 'docker:crowdsec',
			DOCKER_PS_FIXTURE: join(AGENT_DIR, 'ps.jsonl'),
			PATH: `${BIN_DIR}:${process.env.PATH}`
		},
		stdio: 'ignore'
	});
	// Wait for the socket to appear.
	for (let i = 0; i < 100 && !existsSync(AGENT_SOCKET!); i++) {
		await new Promise((r) => setTimeout(r, 50));
	}
	if (!existsSync(AGENT_SOCKET!)) throw new Error('agent socket never appeared');
});

afterAll(() => {
	agent.kill();
	rmSync(AGENT_DIR, { recursive: true, force: true });
});

describe('protocol + auth', () => {
	it('hello reports negotiated capabilities', async () => {
		const r = await call('hello');
		expect(r.ok).toBe(true);
		expect(r.result.caps.cscli).toBe(true);
		expect(r.result.caps.docker).toBe(true);
		expect(r.result.caps.files).toBe(true);
		expect(r.result.caps.services).toEqual(['docker:crowdsec']);
	});

	it('rejects a bad token by closing the connection', async () => {
		await expect(call('hello', {}, 'wrong-token')).rejects.toThrow();
	});

	it('rejects unknown ops', async () => {
		const r = await call('rm.everything');
		expect(r.ok).toBe(false);
		expect(r.error.code).toBe('invalid');
	});
});

describe('cscli ops', () => {
	it('hub.install invokes cscli with validated args', async () => {
		const r = await call('hub.install', { type: 'collections', item: 'crowdsecurity/caddy' });
		expect(r.ok).toBe(true);
		expect(calls()).toContain('cscli collections install crowdsecurity/caddy');
	});

	it('hub.install rejects invalid types and items', async () => {
		expect((await call('hub.install', { type: 'cron', item: 'x' })).ok).toBe(false);
		expect((await call('hub.install', { type: 'collections', item: 'ok; rm -rf /' })).ok).toBe(
			false
		);
		expect(calls().filter((c) => c.includes('rm -rf'))).toHaveLength(0);
	});

	it('allowlist.add creates the list then adds values', async () => {
		const r = await call('allowlist.add', {
			name: 'dashboard-admin',
			description: 'test',
			values: ['203.0.113.7']
		});
		expect(r.ok).toBe(true);
		expect(calls()).toContain('cscli allowlists create dashboard-admin -d test');
		expect(calls()).toContain('cscli allowlists add dashboard-admin 203.0.113.7');
	});

	it('allowlist.add rejects non-IP values', async () => {
		const r = await call('allowlist.add', { name: 'x', values: ['not-an-ip'] });
		expect(r.ok).toBe(false);
	});

	it('simulation.set toggles with an optional scope', async () => {
		expect((await call('simulation.set', { enabled: true })).ok).toBe(true);
		expect(calls()).toContain('cscli simulation enable');
	});

	it('bouncers.add returns the issued key (callers keep it out of logs)', async () => {
		const r = await call('bouncers.add', { name: 'dash-blog-traefik' });
		expect(r.ok).toBe(true);
		expect(r.result.name).toBe('dash-blog-traefik');
		expect(r.result.key).toBe('TEST-KEY-9f8e7d6c5b');
		expect(calls()).toContain('cscli bouncers add dash-blog-traefik -o raw');
	});

	it('bouncers.add rejects invalid names', async () => {
		expect((await call('bouncers.add', { name: 'x; rm -rf /' })).ok).toBe(false);
	});
});

describe('docker read ops', () => {
	it('docker.ps returns the fixture JSONL', async () => {
		const r = await call('docker.ps');
		expect(r.ok).toBe(true);
		expect(r.result.output).toContain('traefik/whoami');
		expect(calls().some((c) => c.startsWith('docker ps'))).toBe(true);
	});

	it('docker.inspect validates the container name', async () => {
		expect((await call('docker.inspect', { name: 'blog' })).ok).toBe(true);
		const bad = await call('docker.inspect', { name: 'x; rm -rf /' });
		expect(bad.ok).toBe(false);
		expect(bad.error.code).toBe('invalid');
	});
});

describe('file + service scoping', () => {
	it('file.write is confined to declared roots', async () => {
		const inside = await call('file.write', {
			path: join(FILE_ROOT, 'acquis.d/site.yaml'),
			content: 'filenames: [x]\n'
		});
		expect(inside.ok).toBe(true);
		expect(readFileSync(join(FILE_ROOT, 'acquis.d/site.yaml'), 'utf8')).toContain('filenames');

		for (const p of ['/etc/passwd', `${FILE_ROOT}/../escape`, '/root/x']) {
			const r = await call('file.write', { path: p, content: 'x' });
			expect(r.ok).toBe(false);
			expect(r.error.code).toBe('denied');
		}
	});

	it('file.backup copies into the backup dir and restore puts it back', async () => {
		const target = join(FILE_ROOT, 'restore-me.conf');
		writeFileSync(target, 'original');
		const b = await call('file.backup', { path: target });
		expect(b.ok).toBe(true);
		expect(b.result.backup).toContain('backups');
		writeFileSync(target, 'clobbered');
		const r = await call('file.restore', { path: target, backup: b.result.backup });
		expect(r.ok).toBe(true);
		expect(readFileSync(target, 'utf8')).toBe('original');
	});

	it('file.restore refuses backups outside the backup dir', async () => {
		const r = await call('file.restore', {
			path: join(FILE_ROOT, 'x'),
			backup: '/etc/hostname'
		});
		expect(r.ok).toBe(false);
	});

	it('service.reload only accepts declared targets', async () => {
		expect((await call('service.reload', { target: 'docker:crowdsec' })).ok).toBe(true);
		expect(calls()).toContain('docker kill -s HUP crowdsec');
		const denied = await call('service.reload', { target: 'systemd:sshd' });
		expect(denied.ok).toBe(false);
		expect(denied.error.code).toBe('denied');
	});
});
