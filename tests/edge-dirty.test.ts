/**
 * Edge-dirty flag semantics: a user-initiated decision change must bypass
 * the 120 s debounce (an unban can't wait 15 min for Cloudflare), and the
 * flag survives an enqueue that throws mid-loop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/server/jobs/queue.ts', async (importOriginal) => {
	const mod = await importOriginal<typeof import('#lib/server/jobs/queue.ts')>();
	return { ...mod, enqueue: vi.fn(async () => ({ job: {}, created: true })) };
});

import { enqueue } from '#lib/server/jobs/queue.ts';
import {
	consumeEdgeDirty,
	markEdgeDirty,
	peekEdgeDirty
} from '#lib/server/cloudflare/edge-dirty.ts';
import { maybeEnqueueEdgeSync } from '#lib/server/crowdsec/worker.ts';
import { db, migrateDatabase } from '#lib/server/db/index.ts';
import { cloudflareAccount } from '#lib/server/db/app.schema.ts';

const enqueueMock = vi.mocked(enqueue);

async function seedAccount(lastSyncAgoMs: number) {
	await db.insert(cloudflareAccount).values({
		id: crypto.randomUUID(),
		name: 'acct',
		tokenEnc: 'x',
		cfAccountId: 'cf',
		listId: 'list-1',
		listName: 'crowdsec_dash_srv',
		listOwned: true,
		tokenStatus: 'active',
		lastSyncAt: new Date(Date.now() - lastSyncAgoMs)
	});
}

beforeEach(async () => {
	await migrateDatabase();
	await db.delete(cloudflareAccount);
	consumeEdgeDirty(); // reset the flag between tests
	enqueueMock.mockClear();
	enqueueMock.mockResolvedValue({ job: {}, created: true } as never);
});

describe('maybeEnqueueEdgeSync dirty flag', () => {
	it('enqueues inside the debounce window when the flag is set', async () => {
		await seedAccount(60_000); // synced 60 s ago — debounce would skip it
		await maybeEnqueueEdgeSync(true); // fresh alerts alone don't bypass
		expect(enqueueMock).not.toHaveBeenCalled();

		markEdgeDirty();
		await maybeEnqueueEdgeSync(false);
		expect(enqueueMock).toHaveBeenCalledTimes(1);
		expect(peekEdgeDirty()).toBe(false); // consumed after a clean loop
	});

	it('keeps the flag when an enqueue throws', async () => {
		await seedAccount(60_000);
		markEdgeDirty();
		enqueueMock.mockRejectedValueOnce(new Error('db gone'));
		await expect(maybeEnqueueEdgeSync(false)).rejects.toThrow('db gone');
		expect(peekEdgeDirty()).toBe(true);

		enqueueMock.mockResolvedValue({ job: {}, created: true } as never);
		await maybeEnqueueEdgeSync(false);
		expect(enqueueMock).toHaveBeenCalledTimes(2); // the retry delivers it
		expect(peekEdgeDirty()).toBe(false);
	});
});
