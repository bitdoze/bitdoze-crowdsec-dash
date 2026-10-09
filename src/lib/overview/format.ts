/**
 * Display helpers for the overview. Locale-independent on purpose: numbers are
 * grouped, times are relative with the absolute value on hover.
 */

const countFormat = new Intl.NumberFormat('en-US');

export function formatCount(value: number): string {
	return countFormat.format(value);
}

/** Abbreviate for tight chart ticks: 1.2k, 3.4M. Full value goes in the title. */
export function abbreviateCount(value: number): string {
	if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (Math.abs(value) >= 10_000) return `${Math.round(value / 1_000)}k`;
	if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

/** "32 s ago", "4 min ago", "2 h ago", "3 d ago". Future dates return "just now". */
export function relativeTime(iso: string, now: Date = new Date()): string {
	const then = new Date(iso).getTime();
	const delta = Math.max(0, now.getTime() - then);
	const seconds = Math.round(delta / 1000);
	if (seconds < 60) return `${seconds} s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return `${days} d ago`;
}

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
	dateStyle: 'medium',
	timeStyle: 'medium'
});

export function formatDateTime(iso: string): string {
	return dateTimeFormat.format(new Date(iso));
}

/** "HH:00" label for an activity bucket. */
export function hourLabel(iso: string): string {
	const d = new Date(iso);
	return `${String(d.getHours()).padStart(2, '0')}:00`;
}

/**
 * Fixed five-step magnitude ramp for scenario counts (star-atlas style).
 * Never normalized to the visible set: a count means the same magnitude on
 * every page.
 */
export function magnitudeLevel(count: number): 0 | 1 | 2 | 3 | 4 | 5 {
	if (count <= 0) return 0;
	if (count < 10) return 1;
	if (count < 100) return 2;
	if (count < 1_000) return 3;
	if (count < 10_000) return 4;
	return 5;
}
