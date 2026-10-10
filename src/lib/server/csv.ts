/** Minimal CSV encoder for export endpoints — quotes commas/newlines/quotes. */
function cell(v: unknown): string {
	if (v === null || v === undefined) return '';
	let s = v instanceof Date ? v.toISOString() : String(v);
	// Formula injection: attacker-controlled fields (alert.message, scenario,
	// hostname…) can begin with = + - @ tab — prefix with ' so Excel/Sheets
	// treat the cell as text.
	if (/^[\t\r ]*[=+\-@]/.test(s)) s = `'${s}`;
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
	return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

export function csvResponse(filename: string, csv: string): Response {
	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${filename}"`
		}
	});
}
