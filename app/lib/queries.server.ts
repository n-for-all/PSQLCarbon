import { userDb } from "~/utils/db.server";

// Newest history entries kept per user and connection
const HISTORY_LIMIT = 500;
const MAX_SQL_LENGTH = 100_000;

interface QueryRun {
	userId: string;
	connectionId: string;
	database: string;
	sql: string;
	success: boolean;
	error?: string | null;
	rowCount?: number | null;
	durationMs?: number | null;
}

/**
 * Adds a query editor run to the history, failures to record never fail the query itself
 */
export async function recordQuery(run: QueryRun) {
	const sql = run.sql.trim();
	if (!sql) return;
	try {
		await userDb.queryHistory.create({
			data: {
				...run,
				sql: sql.slice(0, MAX_SQL_LENGTH),
				error: run.error ? run.error.slice(0, 2000) : null,
			},
		});

		const stale = await userDb.queryHistory.findMany({
			where: { userId: run.userId, connectionId: run.connectionId },
			orderBy: { createdAt: "desc" },
			skip: HISTORY_LIMIT,
			select: { id: true },
		});
		if (stale.length) {
			await userDb.queryHistory.deleteMany({ where: { id: { in: stale.map((entry) => entry.id) } } });
		}
	} catch (error) {
		console.error("Could not record query history", error);
	}
}

/**
 * Runs a query editor statement and records it in the history
 */
export async function runAndRecord<T>(
	run: Omit<QueryRun, "success" | "error" | "rowCount" | "durationMs">,
	execute: () => Promise<T>
): Promise<T> {
	const started = Date.now();
	try {
		const result = await execute();
		// Multiple statements return one result per statement, count the last
		const last: any = Array.isArray(result) ? result[result.length - 1] : result;
		await recordQuery({ ...run, success: true, rowCount: last?.rowCount ?? null, durationMs: Date.now() - started });
		return result;
	} catch (error: any) {
		await recordQuery({ ...run, success: false, error: error?.message || String(error), durationMs: Date.now() - started });
		throw error;
	}
}
