/**
 * One-bit "edge needs a sync now" flag — manual decisions and removals
 * change the list's desired contents without necessarily producing a new
 * synced alert in the same tick, so the worker treats a set flag as fresh
 * activity when deciding whether to enqueue `cloudflare.sync` (and skips
 * the 120 s debounce — the change is user-initiated). Process-local like
 * the rest of the worker.
 */
let dirty = false;

export function markEdgeDirty(): void {
	dirty = true;
}

/** Read without clearing — the enqueue path clears only after it ran. */
export function peekEdgeDirty(): boolean {
	return dirty;
}

export function consumeEdgeDirty(): boolean {
	const was = dirty;
	dirty = false;
	return was;
}
