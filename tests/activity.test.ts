import { describe, expect, it } from 'vitest';
import { bucketHourLabel, dayLabel, downsample } from '#lib/activity.ts';

const pts = (n: number, start = 0) =>
	Array.from({ length: n }, (_, i) => ({ at: start + i * 3600_000, total: i + 1 }));

describe('downsample', () => {
	it('passes through when under the cap', () => {
		const p = pts(10);
		expect(downsample(p, 48)).toBe(p);
	});

	it('merges consecutive buckets, preserving order and total', () => {
		const p = pts(96); // 96 hourly buckets → 48 merged pairs
		const out = downsample(p, 48);
		expect(out).toHaveLength(48);
		expect(out[0]).toEqual({ at: p[0].at, total: 1 + 2 });
		expect(out[47].at).toBe(p[94].at);
		expect(out.reduce((s, b) => s + b.total, 0)).toBe(p.reduce((s, b) => s + b.total, 0));
		expect(out.map((b) => b.at)).toEqual([...out.map((b) => b.at)].sort((a, b) => a - b));
	});

	it('handles non-divisible sizes — the last bucket is short', () => {
		const p = pts(100);
		const out = downsample(p, 48); // width 3 → 34 buckets (33×3 + 1)
		expect(out.length).toBeLessThanOrEqual(48);
		expect(out.reduce((s, b) => s + b.total, 0)).toBe(p.reduce((s, b) => s + b.total, 0));
	});

	it('labels: hour format for sub-day, day format for ranges', () => {
		const t = new Date('2026-10-09T14:00:00Z').getTime();
		expect(bucketHourLabel(t)).toMatch(/^\d{2}:00$/);
		expect(dayLabel(t)).toBe('Oct 9');
	});
});
