import { createReadStream } from 'node:fs';
import type { RequestHandler } from './$types';
import { requirePermission } from '#lib/server/roles.ts';
import { createBackup } from '#lib/server/ops.ts';
import { recordAudit } from '#lib/server/audit.ts';

/** Download a consistent SQLite snapshot of the app database. */
export const GET: RequestHandler = async (event) => {
	requirePermission(event, 'configure');
	try {
		const { file, bytes } = await createBackup();
		await recordAudit({
			event,
			action: 'system.backup',
			detail: { file: file.split('/').pop(), bytes }
		});
		return new Response(createReadStream(file) as unknown as ReadableStream, {
			headers: {
				'content-type': 'application/vnd.sqlite3',
				'content-length': String(bytes),
				'content-disposition': `attachment; filename="${file.split('/').pop()}"`
			}
		});
	} catch (e) {
		return Response.json(
			{ error: e instanceof Error ? e.message : 'Backup failed' },
			{ status: 500 }
		);
	}
};
