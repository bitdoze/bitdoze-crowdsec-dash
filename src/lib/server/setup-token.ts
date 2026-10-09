import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

export type SetupAttempt = 'ok' | 'invalid' | 'too_many';

function digest(value: string): Buffer {
	return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Holds the one-time first-run setup token in memory. Verification is
 * constant-time (SHA-256 digests compared with timingSafeEqual, so the token
 * length is not leaked) and a successful verify is atomic — the token is
 * single-use, so a concurrent second attempt cannot slip through. `release()`
 * re-arms it when the follow-up action (admin creation) failed for a reason
 * unrelated to the token. Failed attempts are limited to 10 per 15 minutes
 * per process.
 */
export class SetupToken {
	readonly token: string;
	#used = false;
	#failedAt: number[] = [];
	#now: () => number;

	constructor(token?: string, now: () => number = () => Date.now()) {
		this.token = token || randomBytes(32).toString('base64url');
		this.#now = now;
	}

	get active(): boolean {
		return !this.#used;
	}

	verify(candidate: string): SetupAttempt {
		if (this.#used) return 'invalid';
		const cutoff = this.#now() - WINDOW_MS;
		this.#failedAt = this.#failedAt.filter((t) => t > cutoff);
		if (this.#failedAt.length >= MAX_FAILURES) return 'too_many';
		const ok =
			typeof candidate === 'string' &&
			candidate.length > 0 &&
			timingSafeEqual(digest(candidate), digest(this.token));
		if (!ok) {
			this.#failedAt.push(this.#now());
			return 'invalid';
		}
		this.#used = true;
		return 'ok';
	}

	/** Re-arms the token after the action it guarded failed. */
	release(): void {
		this.#used = false;
	}
}
