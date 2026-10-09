/**
 * Shared activity-bucket helpers. Pure module — safe on client and server.
 * The `activity_rollup` table stores hourly counts per site; long-range
 * views downsample to a bounded number of buckets so charts stay readable
 * and payloads small (spec §9: long-range downsampling).
 */

export interface BucketPoint {
	/** Bucket start, epoch ms. */
	at: number;
	total: number;
}

/**
 * Merge consecutive buckets so the result has at most `maxPoints` points,
 * preserving chronological order and the total sum. Bucket width widens to
 * `ceil(n / maxPoints)` source buckets; the last bucket may be short.
 */
export function downsample(points: BucketPoint[], maxPoints = 48): BucketPoint[] {
	if (points.length <= maxPoints || maxPoints < 1) return points;
	const width = Math.ceil(points.length / maxPoints);
	const out: BucketPoint[] = [];
	for (let i = 0; i < points.length; i += width) {
		let total = 0;
		for (let j = i; j < Math.min(i + width, points.length); j++) total += points[j].total;
		out.push({ at: points[i].at, total });
	}
	return out;
}

/** 'Oct 9' — label for day-and-larger buckets. */
export function dayLabel(at: number | string | Date): string {
	const d = new Date(at);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** '14:00' — label for sub-day buckets. */
export function bucketHourLabel(at: number | string | Date): string {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, '0')}:00`;
}
