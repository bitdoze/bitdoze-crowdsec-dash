/** Minimal CSV encoder for export endpoints — quotes commas/newlines/quotes. */
function cell(v: unknown): string {
	if (v === null || v === undefined) return '';
	const s = v instanceof Date ? v.toISOString() : String(v);
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
