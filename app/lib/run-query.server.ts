import type { FieldDef, Pool, PoolClient } from "pg";

// Results bigger than this are cut, a SELECT on a big table would otherwise load every row into the app.
// Exports run the query again and get every row.
export const MAX_RESULT_ROWS = 1000;

export interface UserQueryResult {
	fields: FieldDef[];
	rows: any[];
	rowCount: number | null;
	command: string;
	// More rows exist than were returned
	truncated: boolean;
}

// Statements a cursor can run: plain queries. Anything else, or a query a cursor refuses (several statements,
// a WITH that changes data), runs as it is.
const READS = /^\s*(\(|select\b|with\b|values\b|table\b)/i;
const LEADING_COMMENTS = /^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*/;

const stripTrailingSemicolons = (sql: string) => sql.replace(/[;\s]+$/, "");

/**
 * Runs SQL typed by the user. Queries are read through a cursor so at most `maxRows` rows come back, other
 * statements run normally.
 */
export async function runUserQuery(pool: Pool, sql: string, maxRows = MAX_RESULT_ROWS): Promise<UserQueryResult> {
	const client = await pool.connect();
	try {
		if (READS.test(sql.replace(LEADING_COMMENTS, ""))) {
			const limited = await readThroughCursor(client, sql, maxRows);
			if (limited) return limited;
		}
		const result: any = await client.query(sql);
		// Several statements give one result each, the last one is shown
		const last = Array.isArray(result) ? result[result.length - 1] : result;
		const rows = last?.rows || [];
		return {
			fields: last?.fields || [],
			rows: rows.slice(0, maxRows),
			rowCount: last?.rowCount ?? null,
			command: last?.command || "",
			truncated: rows.length > maxRows,
		};
	} finally {
		client.release();
	}
}

/**
 * Null when the statement can't be run as a cursor, the caller then runs it as it is. Declaring the cursor only
 * plans the query, so a refused one hasn't done anything yet.
 */
async function readThroughCursor(client: PoolClient, sql: string, maxRows: number): Promise<UserQueryResult | null> {
	await client.query("BEGIN");
	try {
		await client.query(`DECLARE psqlcarbon_result NO SCROLL CURSOR FOR ${stripTrailingSemicolons(sql)}`);
	} catch {
		await client.query("ROLLBACK");
		return null;
	}
	try {
		// One more than shown, to know whether there are more
		const result = await client.query(`FETCH ${maxRows + 1} FROM psqlcarbon_result`);
		await client.query("COMMIT");
		return {
			fields: result.fields,
			rows: result.rows.slice(0, maxRows),
			rowCount: Math.min(result.rows.length, maxRows),
			command: "SELECT",
			truncated: result.rows.length > maxRows,
		};
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	}
}
