/**
 * Job runners — each kind maps params to recorded steps. Params are
 * revalidated here (not trusted from the caller) and again inside the
 * agent, which is the actual security boundary for host access.
 */
import { asc, eq } from 'drizzle-orm';
import type { db } from '#lib/server/db/index.ts';
import { configArtifact, jobStep, type job } from '#lib/server/db/app.schema.ts';
import { callAgent } from '#lib/server/agent/client.ts';

type Database = typeof db;
type JobRow = typeof job.$inferSelect;

export type JobContext = { database: Database; job: JobRow };
export type JobStep = { name: string; run: (ctx: JobContext) => Promise<unknown> };
export type Runner = {
	plan: (params: Record<string, unknown>) => JobStep[] | Promise<JobStep[]>;
	rollback?: (params: Record<string, unknown>, ctx: JobContext) => JobStep[] | Promise<JobStep[]>;
};

const HUB_ITEM = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const PATH = /^\/[a-zA-Z0-9._/~-]{1,255}$/;
const TARGET = /^(systemd|docker):[a-zA-Z0-9_.:-]{1,63}$/;
const IP_OR_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/;

function bad(msg: string): never {
	throw new Error(msg);
}

/** A failed agent call is a step failure — never silently continue. */
async function call(op: string, params: Record<string, unknown>) {
	const r = await callAgent(op, params);
	if (!r.ok) throw new Error(`${op}: ${r.error.message}`);
	return r.result;
}

function asStrings(v: unknown): string[] {
	if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) bad('expected string[]');
	return v;
}

export const RUNNERS: Record<string, Runner> = {
	/** Install hub items for a site — one step per typed item. */
	'hub.install': {
		plan: (params) => {
			// items come as "type:item" pairs, e.g. "collections:crowdsecurity/caddy"
			const pairs = asStrings(params.items);
			if (!pairs.length || pairs.length > 32) bad('items: 1–32 hub items');
			const items = pairs.map((pair) => {
				const [type, item] = pair.split(':', 2);
				if (
					!['collections', 'parsers', 'scenarios', 'contexts', 'appsec-rules'].includes(type) ||
					!HUB_ITEM.test(item || '')
				)
					bad(`invalid hub item ${pair}`);
				return { type, item };
			});
			return [
				{ name: 'hub update', run: () => call('hub.update', {}) },
				...items.map(({ type, item }) => ({
					name: `install ${item}`,
					run: () => call('hub.install', { type, item })
				}))
			];
		}
	},

	/** Create/update a centralized allowlist and add values (admin's IP). */
	'allowlist.add': {
		plan: (params) => {
			const name = String(params.name ?? '');
			const values = asStrings(params.values);
			if (!NAME.test(name)) bad('invalid allowlist name');
			if (!values.length || !values.every((v) => IP_OR_CIDR.test(v)))
				bad('values must be IPs/CIDRs');
			return [
				{
					name: `allowlist ${name} += ${values.join(', ')}`,
					run: () =>
						call('allowlist.add', {
							name,
							description: String(params.description ?? '').slice(0, 200),
							values
						})
				}
			];
		}
	},

	'allowlist.remove': {
		plan: (params) => {
			const name = String(params.name ?? '');
			const value = String(params.value ?? '');
			if (!NAME.test(name) || !IP_OR_CIDR.test(value)) bad('need {name, value}');
			return [
				{
					name: `remove ${value} from ${name}`,
					run: () => call('allowlist.remove', { name, value })
				}
			];
		}
	},

	/** Toggle CrowdSec simulation mode (observe without banning). */
	'simulation.set': {
		plan: (params) => {
			const scope = params.scope === undefined ? undefined : String(params.scope);
			if (scope !== undefined && !HUB_ITEM.test(scope)) bad('invalid scope');
			return [
				{
					name: `simulation ${params.enabled ? 'enable' : 'disable'}${scope ? ` ${scope}` : ''}`,
					run: () => call('simulation.set', { enabled: !!params.enabled, scope })
				}
			];
		}
	},

	/**
	 * Managed apply of a generated artifact: backup → write → optional
	 * reload. On failure after the write, restores the recorded backup and
	 * reloads again.
	 */
	'config.apply': {
		plan: (params) => {
			const path = String(params.path ?? '');
			const content = String(params.content ?? '');
			if (!PATH.test(path)) bad('invalid target path');
			if (!content || content.length > 256 * 1024) bad('content missing or >256KiB');
			const reload = params.reloadTarget === undefined ? undefined : String(params.reloadTarget);
			if (reload !== undefined && !TARGET.test(reload)) bad('invalid reload target');
			const artifactId = params.artifactId === undefined ? undefined : String(params.artifactId);
			const steps: JobStep[] = [
				{ name: `backup ${path}`, run: () => call('file.backup', { path }) },
				{ name: `write ${path}`, run: () => call('file.write', { path, content }) }
			];
			if (reload) {
				steps.push({
					name: `reload ${reload}`,
					run: () => call('service.reload', { target: reload })
				});
			}
			if (artifactId) {
				steps.push({
					name: 'mark artifact applied',
					run: async (ctx) => {
						await ctx.database
							.update(configArtifact)
							.set({ state: 'applied', updatedAt: new Date() })
							.where(eq(configArtifact.id, artifactId));
						return 'artifact state → applied';
					}
				});
			}
			return steps;
		},
		rollback: async (params, ctx) => {
			const path = String(params.path);
			const reload = params.reloadTarget === undefined ? undefined : String(params.reloadTarget);
			const steps = await ctx.database
				.select()
				.from(jobStep)
				.where(eq(jobStep.jobId, ctx.job.id))
				.orderBy(asc(jobStep.idx));
			const backupDetail = steps.find((s) => s.idx === 0)?.detail;
			let backup: string | null = null;
			try {
				backup = backupDetail ? (JSON.parse(backupDetail).backup ?? null) : null;
			} catch {
				backup = null;
			}
			const out: JobStep[] = [];
			if (backup) {
				out.push({ name: `restore ${path}`, run: () => call('file.restore', { path, backup }) });
			}
			if (reload) {
				out.push({
					name: `reload ${reload}`,
					run: () => call('service.reload', { target: reload })
				});
			}
			return out;
		}
	}
};
