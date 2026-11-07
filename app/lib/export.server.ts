import type { Pool } from "pg";

export type ExportFormat = "csv" | "json";

const FETCH_SIZE = 1000;

const toText = (value: unknown): string => {
	if (value === null || value === undefined) return "";
	if (value instanceof Date) return isNaN(value.getTime()) ? String(value) : value.toISOString();
	if (Buffer.isBuffer(value)) return `\\x${value.toString("hex")}`;
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
};

const toJson = (value: unknown): unknown => {
	if (value instanceof Date) return isNaN(value.getTime()) ? String(value) : value.toISOString();
	if (Buffer.isBuffer(value)) return `\\x${value.toString("hex")}`;
	return value;
};

const csvCell = (value: unknown) => {
	const text = toText(value);
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * Streams every row of a query as CSV or JSON. The query runs in a read only transaction through a cursor,
 * one statement only, so an export can't change anything and large results never sit in memory.
 */
export async function* exportQuery(pool: Pool, sql: string, format: ExportFormat): AsyncGenerator<string> {
	const statement = sql.trim().replace(/;\s*$/, "");
	if (!statement) throw new Error("The query is empty");

	const client = await pool.connect();
	try {
		await client.query("BEGIN READ ONLY");
		try {
			await client.query({ text: `DECLARE export_rows NO SCROLL CURSOR FOR ${statement}`, queryMode: "extended" } as any);
		} catch (error: any) {
			if (error?.code === "42601" && /multiple commands/i.test(error.message)) throw new Error("Only a single query can be exported");
			if (error?.code === "42601") throw new Error(`Only queries that return rows (SELECT, VALUES, TABLE ...) can be exported: ${error.message}`);
			throw error;
		}

		let columns: string[] | null = null;
		let first = true;
		if (format === "json") yield "[";
		for (;;) {
			const result = await client.query({ text: `FETCH ${FETCH_SIZE} FROM export_rows`, rowMode: "array" } as any);
			if (!columns) {
				const header: string[] = result.fields.map((field: any) => field.name);
				columns = header;
				// Excel opens UTF-8 CSV correctly with a byte order mark
				if (format === "csv") yield "\uFEFF" + header.map(csvCell).join(",") + "\r\n";
			}
			const names: string[] = columns ?? [];
			let chunk = "";
			for (const row of result.rows as unknown[][]) {
				if (format === "csv") {
					chunk += row.map(csvCell).join(",") + "\r\n";
				} else {
					const object = Object.fromEntries(names.map((column, i) => [column, toJson(row[i])]));
					chunk += (first ? "\n  " : ",\n  ") + JSON.stringify(object);
					first = false;
				}
			}
			if (chunk) yield chunk;
			if (result.rows.length < FETCH_SIZE) break;
		}
		if (format === "json") yield first ? "]\n" : "\n]\n";
		await client.query("ROLLBACK");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release(true);
	}
}
