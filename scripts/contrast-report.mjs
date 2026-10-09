#!/usr/bin/env node
/**
 * WCAG contrast report for the Inspection Record tokens.
 *
 * Parses the oklch() token values from src/routes/layout.css for both themes
 * and reports the contrast ratio for every foreground/background pair the UI
 * uses. Thresholds: AA text 4.5:1, non-text UI (borders, focus ring) 3:1.
 *
 * Usage: node scripts/contrast-report.mjs   (exit 1 on any failure)
 */
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/routes/layout.css', import.meta.url), 'utf8');

/** Extract `--name: oklch(L C H)` declarations from a CSS block. */
function parseTokens(block) {
	const tokens = {};
	for (const m of block.matchAll(/--([\w-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g)) {
		tokens[m[1]] = { l: +m[2], c: +m[3], h: +m[4] };
	}
	return tokens;
}

function blockAfter(marker) {
	const i = css.indexOf(marker);
	if (i === -1) throw new Error(`marker not found: ${marker}`);
	return css.slice(i, i + 4000);
}

const light = parseTokens(blockAfter(':root {'));
const dark = parseTokens(blockAfter('@media (prefers-color-scheme: dark)'));

// OKLCH -> OKLab -> linear sRGB -> relative luminance (WCAG).
function luminance({ l, c, h }) {
	const a = c * Math.cos((h * Math.PI) / 180);
	const b = c * Math.sin((h * Math.PI) / 180);
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541729 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
	const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
	const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
	return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function ratio(fg, bg) {
	const [hi, lo] = [Math.max(fg, bg), Math.min(fg, bg)];
	return (hi + 0.05) / (lo + 0.05);
}

// [fg, bg, min, label]
const pairs = [
	['ink', 'paper', 4.5, 'body text on page'],
	['ink', 'sheet', 4.5, 'text on cards/modules'],
	['ink', 'panel', 4.5, 'text on sidebar/evidence'],
	['ink-2', 'paper', 4.5, 'secondary text on page'],
	['ink-2', 'sheet', 4.5, 'secondary text on cards'],
	['ink-2', 'panel', 4.5, 'secondary text on sidebar'],
	['ink-3', 'paper', 4.5, 'hint text on page'],
	['ink-3', 'sheet', 4.5, 'hint text on cards'],
	['ink-3', 'panel', 4.5, 'hint text on sidebar'],
	['accent-ink', 'accent', 4.5, 'primary button'],
	['accent', 'paper', 4.5, 'accent text on page'],
	['accent', 'sheet', 4.5, 'accent text (FI code) on cards'],
	['verified', 'verified-tint', 4.5, 'VERIFIED stamp'],
	['degraded', 'degraded-tint', 4.5, 'DEGRADED stamp'],
	['failed', 'failed-tint', 4.5, 'FAILED stamp'],
	['stale', 'stale-tint', 4.5, 'STALE stamp'],
	['ink-3', 'stale-tint', 4.5, 'N/C stamp'],
	['line', 'paper', 3.0, 'control border on page'],
	['line', 'sheet', 3.0, 'control border on cards'],
	['line', 'panel', 3.0, 'control border on sidebar'],
	['rule', 'paper', 0, 'decorative hairline on page'],
	['rule', 'sheet', 0, 'decorative hairline on cards'],
	['rule-strong', 'paper', 0, 'decorative strong rule on page'],
	['rule-strong', 'sheet', 0, 'decorative strong rule on cards'],
	['accent-outline', 'paper', 3.0, 'focus ring on page'],
	['accent-outline', 'sheet', 3.0, 'focus ring on cards']
];

let failed = 0;
for (const [theme, tokens] of [
	['light', light],
	['dark', dark]
]) {
	console.log(`\n${theme.toUpperCase()}`);
	for (const [fg, bg, min, label] of pairs) {
		if (!tokens[fg] || !tokens[bg]) {
			console.log(`  MISSING ${fg}/${bg} (${label})`);
			failed++;
			continue;
		}
		const r = ratio(luminance(tokens[fg]), luminance(tokens[bg]));
		const ok = r >= min;
		if (!ok) failed++;
		const need = min === 0 ? 'info' : `need ${min}`;
		console.log(`  ${ok ? 'PASS' : 'FAIL'} ${r.toFixed(2).padStart(5)}:1 (${need}) ${label}`);
	}
}
console.log(failed === 0 ? '\nAll pairs pass.' : `\n${failed} pair(s) below threshold.`);
process.exit(failed === 0 ? 0 : 1);
