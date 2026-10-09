/**
 * Durable job queue (spec §10). Jobs are rows — a browser disconnect never
 * cancels server work, a crashed worker's lease expires and the job is
 * reclaimed, and completed steps are not re-run on resume.
 */
import { and, asc, desc, eq, lt, ne, or, sql } from 'drizzle-orm';
import type { db } from '#lib/server/db/index.ts';
import { job, jobStep } from '#lib/server/db/app.schema.ts';
import { RUNNERS, type JobContext } from '#lib/server/jobs/runners.ts';
import { recordEvent } from '#lib/server/notify/core.ts';

type Database = typeof db;
type JobRow = typeof job.$inferSelect;

export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
const ACTIVE_STATES = new Set(['queued', 'running', 'cancel_requested', 'rollback_running']);

export const uid = () => crypto.randomUUID();

/**
 * Submit a job. An in-flight job with the same idempotency key returns the
 * existing row — a *finished* one doesn't, since resubmitting a completed or
 * failed unit of work is legitimate (the ops themselves are idempotent). The
 * retried row gets a derived key so the unique index still holds.
 */
export async function enqueue(
	database: Database,
	input: {
		kind: keyof typeof RUNNERS & string;
		params: Record<string, unknown>;
		idempotencyKey?: string;
		lockKey?: string;
		siteId?: string;
		createdBy?: string;
	}
): Promise<{ job: JobRow; created: boolean }> {
	const now = new Date();
	const row = {
		id: uid(),
		kind: input.kind,
		params: JSON.stringify(input.params),
		state: 'queued' as const,
		idempotencyKey: input.idempotencyKey ?? null,
		lockKey: input.lockKey ?? null,
		siteId: input.siteId ?? null,
		attempts: 0,
		leaseUntil: null,
		leasedBy: null,
		result: null,
		createdBy: input.createdBy ?? null,
		createdAt: now,
		updatedAt: now,
		startedAt: null,
		finishedAt: null
	};
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			await database.insert(job).values(row);
			return { job: row, created: true };
		} catch {
			if (!input.idempotencyKey) throw new Error('enqueue failed');
			// Latest submission under this key — the base row or any ~retry.
			const [existing] = await database
				.select()
				.from(job)
				.where(
					sql`(${job.idempotencyKey} = ${input.idempotencyKey} OR ${job.idempotencyKey} LIKE ${input.idempotencyKey + '~%'})`
				)
				.orderBy(desc(job.createdAt))
				.limit(1);
			if (existing && ACTIVE_STATES.has(existing.state)) {
				return { job: existing, created: false };
			}
			row.idempotencyKey = `${input.idempotencyKey}~${crypto.randomUUID().slice(0, 8)}`;
		}
	}
	throw new Error('enqueue failed');
}

/**
 * Lease the next runnable job: queued jobs first (oldest wins), then running
 * jobs whose lease expired (abandoned by a crashed worker). A job with a
 * lockKey already held by an active job is skipped this round.
 */
export async function claimNext(database: Database, workerId: string): Promise<JobRow | null> {
	const now = new Date();
	const candidates = await database
		.select()
		.from(job)
		.where(
			or(
				eq(job.state, 'queued'),
				and(eq(job.state, 'running'), lt(job.leaseUntil, now)),
				and(eq(job.state, 'cancel_requested'), lt(job.leaseUntil, now))
			)
		)
		.orderBy(asc(job.createdAt))
		.limit(20);

	const activeLocks = new Set(
		(
			await database
				.select({ lockKey: job.lockKey })
				.from(job)
				.where(
					and(sql`${job.state} IN ('running','rollback_running')`, sql`${job.lockKey} IS NOT NULL`)
				)
		).map((r) => r.lockKey)
	);

	for (const cand of candidates) {
		// Owner died mid-cancel — nothing left to stop; finalize it.
		if (cand.state === 'cancel_requested') {
			await database
				.update(job)
				.set({ state: 'cancelled', result: 'Cancelled by user.', finishedAt: now, updatedAt: now })
				.where(eq(job.id, cand.id));
			continue;
		}
		if (cand.lockKey && activeLocks.has(cand.lockKey) && cand.state === 'queued') continue;
		const attempts = cand.state === 'running' ? cand.attempts + 1 : cand.attempts;
		if (cand.state === 'running' && attempts >= MAX_ATTEMPTS) {
			await database
				.update(job)
				.set({
					state: 'failed',
					result: 'Lease lost 3 times — abandoned as failed.',
					finishedAt: now,
					updatedAt: now
				})
				.where(eq(job.id, cand.id));
			continue;
		}
		const [claimed] = await database
			.update(job)
			.set({
				state: 'running',
				leasedBy: workerId,
				leaseUntil: new Date(now.getTime() + LEASE_MS),
				attempts,
				startedAt: cand.startedAt ?? now,
				updatedAt: now
			})
			.where(and(eq(job.id, cand.id), ne(job.state, 'cancelled')))
			.returning();
		if (claimed) return claimed;
	}
	return null;
}

/** Persist a step outcome; returns the stored row id for resume checks. */
async function writeStep(
	database: Database,
	jobId: string,
	idx: number,
	name: string,
	state: 'running' | 'succeeded' | 'failed' | 'skipped',
	detail?: string
) {
	const id = `${jobId}|${idx}`;
	const now = new Date();
	await database
		.insert(jobStep)
		.values({
			id,
			jobId,
			idx,
			name,
			state,
			detail: detail?.slice(0, 8000) ?? null,
			startedAt: state === 'running' ? now : undefined,
			finishedAt: state === 'running' ? undefined : now
		})
		.onConflictDoUpdate({
			target: jobStep.id,
			set: {
				state,
				detail: detail?.slice(0, 8000) ?? null,
				finishedAt: state === 'running' ? undefined : now
			}
		});
}

async function heartbeat(database: Database, jobId: string) {
	await database
		.update(job)
		.set({ leaseUntil: new Date(Date.now() + LEASE_MS), updatedAt: new Date() })
		.where(eq(job.id, jobId));
}

async function cancelRequested(database: Database, jobId: string) {
	const [j] = await database
		.select({ state: job.state })
		.from(job)
		.where(eq(job.id, jobId))
		.limit(1);
	return j?.state === 'cancel_requested';
}

/**
 * Execute a claimed job. Steps that already succeeded (a resumed job) are
 * skipped; cancellation is honored at step boundaries only; a runner may
 * return rollback steps that run on failure.
 */
export async function runClaimed(database: Database, j: JobRow): Promise<void> {
	const runner = RUNNERS[j.kind];
	const finish = async (state: JobRow['state'], result: string) => {
		await database
			.update(job)
			.set({ state, result: result.slice(0, 4000), finishedAt: new Date(), updatedAt: new Date() })
			.where(eq(job.id, j.id));
		// One inbox/outbox event per failed job row — retries are new rows.
		if (state === 'failed' || state === 'rollback_failed') {
			await recordEvent(database, {
				eventKey: `job.${state}.${j.id}`,
				class: 'job',
				severity: state === 'rollback_failed' ? 'critical' : 'warning',
				title: `Job ${j.kind} ${state === 'rollback_failed' ? 'failed and rollback failed' : 'failed'}`,
				body: result.slice(0, 500),
				href: '/system'
			}).catch(() => undefined);
		}
	};
	if (!runner) return finish('failed', `unknown job kind ${j.kind}`);

	let steps;
	try {
		steps = await runner.plan(JSON.parse(j.params));
	} catch (e) {
		return finish('failed', `invalid params: ${e instanceof Error ? e.message : String(e)}`);
	}

	const prior = await database.select().from(jobStep).where(eq(jobStep.jobId, j.id));
	const done = new Set(prior.filter((s) => s.state === 'succeeded').map((s) => s.idx));
	const ctx: JobContext = { database, job: j, secrets: {} };

	for (const [i, step] of steps.entries()) {
		// Secret-producing steps re-run even when already succeeded — their
		// result lives only in memory and is lost on worker restart.
		if (done.has(i) && !step.ephemeral) continue;
		if (await cancelRequested(database, j.id)) return finish('cancelled', 'Cancelled by user.');
		await writeStep(database, j.id, i, step.name, 'running');
		await heartbeat(database, j.id);
		try {
			const out = await step.run(ctx);
			await writeStep(
				database,
				j.id,
				i,
				step.name,
				'succeeded',
				typeof out === 'string' ? out : JSON.stringify(out)?.slice(0, 8000)
			);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			await writeStep(database, j.id, i, step.name, 'failed', message);
			const rollbackSteps = runner.rollback
				? await runner.rollback(JSON.parse(j.params), ctx)
				: null;
			if (!rollbackSteps?.length) return finish('failed', message);
			// Rollback phase — restore what the completed steps changed.
			await database
				.update(job)
				.set({ state: 'rollback_running', updatedAt: new Date() })
				.where(eq(job.id, j.id));
			for (const [k, rstep] of rollbackSteps.entries()) {
				const ridx = 1000 + k;
				await writeStep(database, j.id, ridx, `rollback: ${rstep.name}`, 'running');
				await heartbeat(database, j.id);
				try {
					const out = await rstep.run(ctx);
					await writeStep(
						database,
						j.id,
						ridx,
						`rollback: ${rstep.name}`,
						'succeeded',
						typeof out === 'string' ? out : JSON.stringify(out)?.slice(0, 8000)
					);
				} catch (re) {
					await writeStep(
						database,
						j.id,
						ridx,
						`rollback: ${rstep.name}`,
						'failed',
						re instanceof Error ? re.message : String(re)
					);
					return finish(
						'rollback_failed',
						`${message} — rollback failed: ${re instanceof Error ? re.message : String(re)}`
					);
				}
			}
			return finish('failed', `${message} — rolled back`);
		}
	}
	return finish('succeeded', `${steps.length} step${steps.length === 1 ? '' : 's'} completed`);
}

/** Ask a job to stop at the next step boundary (or immediately if queued). */
export async function requestCancel(database: Database, jobId: string): Promise<boolean> {
	const [j] = await database.select().from(job).where(eq(job.id, jobId)).limit(1);
	if (!j) return false;
	if (j.state === 'queued') {
		await database
			.update(job)
			.set({ state: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
			.where(eq(job.id, jobId));
		return true;
	}
	if (j.state === 'running' || j.state === 'rollback_running') {
		await database
			.update(job)
			.set({ state: 'cancel_requested', updatedAt: new Date() })
			.where(eq(job.id, jobId));
		return true;
	}
	return false;
}

/** Drain all currently-claimable work — the worker calls this each tick. */
export async function drainJobs(database: Database, workerId: string, maxPerTick = 8) {
	for (let i = 0; i < maxPerTick; i++) {
		const claimed = await claimNext(database, workerId);
		if (!claimed) return;
		await runClaimed(database, claimed);
	}
}

export async function listJobs(database: Database, limit = 50) {
	return database
		.select()
		.from(job)
		.orderBy(sql`${job.createdAt} DESC`)
		.limit(limit);
}

export async function jobDetail(database: Database, jobId: string) {
	const [j] = await database.select().from(job).where(eq(job.id, jobId)).limit(1);
	if (!j) return null;
	const steps = await database
		.select()
		.from(jobStep)
		.where(eq(jobStep.jobId, jobId))
		.orderBy(asc(jobStep.idx));
	return { job: j, steps };
}
