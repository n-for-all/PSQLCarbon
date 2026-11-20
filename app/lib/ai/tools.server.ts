import type { Pool, QueryArrayResult } from "pg";
import { userDb } from "~/utils/db.server";
import { exportQuery } from "~/lib/export.server";

export type WriteMode = "read_only" | "ask" | "auto";
export const WRITE_MODES: WriteMode[] = ["read_only", "ask", "auto"];

const STATEMENT_TIMEOUT_MS = 30_000;
// Rows kept for the UI and rows the model gets to see per result
const UI_MAX_ROWS = 200;
const MODEL_MAX_ROWS = 50;
const MODEL_MAX_CELL = 300;
const MODEL_MAX_CHARS = 24_000;

// Functions that have side effects even inside a read only transaction
const SIDE_EFFECT_FUNCTIONS = /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_restore_point|pg_promote|lo_import|lo_export|lo_unlink|dblink_exec|pg_advisory_lock\w*|set_config)\s*\(/i;

export interface ResultSet {
	command: string;
	rowCount: number | null;
	columns: string[];
	rows: unknown[][];
	truncated: boolean;
}

/**
 * What the UI shows for a tool call, stored with the tool message
 */
export interface ToolDisplay {
	tool: string;
	sql?: string;
	database?: string;
	results?: ResultSet[];
	write?: boolean;
	durationMs?: number;
	error?: string;
	rejected?: boolean;
	skipped?: boolean;
	text?: string;
	/** A file the user can download from the chat, the UI fetches it from the backup or export endpoint */
	download?:
		| { kind: "export"; database: string; sql: string; format: "csv" | "json" }
		| { kind: "backup"; database: string; content: "all" | "schema" | "data"; gzip: boolean };
}

export interface ToolOutcome {
	content: string;
	display: ToolDisplay;
}

export interface ToolContext {
	/** The chat's database, used when a tool call doesn't name one */
	database: string;
	/** Pool for a database on this connection, throws when the database isn't allowed */
	resolvePool: (database?: string) => { pool: Pool; database: string };
	listDatabases: () => Promise<string[]>;
	writeMode: WriteMode;
	userId: string;
	connectionId: string;
	/** Set when the user approved this specific call */
	approved?: boolean;
}

export const NEEDS_APPROVAL = "needs_approval" as const;

export const TOOL_DEFINITIONS = [
	{
		type: "function",
		function: {
			name: "list_databases",
			description: "List the databases on this server that you can use. A query only sees one database, pass database to the other tools to work in another one.",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "list_tables",
			description: "List the tables, views and materialized views in the database with their estimated row counts and sizes.",
			parameters: {
				type: "object",
				properties: {
					schema: { type: "string", description: "Only list objects in this schema, all schemas when omitted" },
					database: { type: "string", description: "Database on this server to use, the chat's database when omitted. Use list_databases to see them" },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "describe_table",
			description: "Get the columns, types, defaults, constraints (primary/foreign keys), indexes, estimated row count and a few sample rows of a table or view.",
			parameters: {
				type: "object",
				properties: {
					schema: { type: "string", description: "Schema name, defaults to public" },
					database: { type: "string", description: "Database on this server to use, the chat's database when omitted. Use list_databases to see them" },
					table: { type: "string", description: "Table or view name, exactly as stored (case sensitive)" },
				},
				required: ["table"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "run_query",
			description:
				"Run SQL on the database and get the results back. Reads run immediately in a read only transaction, one statement per call. Statements that change data or schema follow the user's change setting (they may need the user's approval) and may contain several statements.",
			parameters: {
				type: "object",
				properties: {
					sql: { type: "string", description: "The SQL to run" },
					purpose: { type: "string", description: "One short sentence telling the user why this query runs" },
					database: { type: "string", description: "Database on this server to use, the chat's database when omitted. Use list_databases to see them" },
				},
				required: ["sql"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "export_query_results",
			description:
				"Give the user a download of every row a query returns, as CSV or JSON. Use it when the user wants to export or download results. Only read queries can be exported.",
			parameters: {
				type: "object",
				properties: {
					sql: { type: "string", description: "A single SELECT (or WITH/VALUES/TABLE) query" },
					format: { type: "string", enum: ["csv", "json"], description: "csv unless the user asks for JSON" },
					database: { type: "string", description: "Database to run it on, the chat's database when omitted" },
				},
				required: ["sql"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "create_backup",
			description:
				"Give the user a download of a database backup (plain SQL, the same as the Backup & Restore page). Use it when the user asks to back up or dump a database. It doesn't restore or change anything.",
			parameters: {
				type: "object",
				properties: {
					database: { type: "string", description: "Database to back up, the chat's database when omitted" },
					content: { type: "string", enum: ["all", "schema", "data"], description: "Schema and data (default), schema only or data only" },
					gzip: { type: "boolean", description: "Compress the file (.sql.gz)" },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "save_memory",
			description:
				"Remember a durable fact about this database for future chats, e.g. what a table or status value means, naming conventions or the user's preferences. Don't save query results or temporary details.",
			parameters: {
				type: "object",
				properties: {
					content: { type: "string", description: "The fact to remember, one or two sentences" },
				},
				required: ["content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "forget_memory",
			description: "Delete a saved memory that is wrong or outdated.",
			parameters: {
				type: "object",
				properties: {
					id: { type: "string", description: "The memory id" },
				},
				required: ["id"],
			},
		},
	},
];

const serializeCell = (value: unknown): unknown => {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return isNaN(value.getTime()) ? String(value) : value.toISOString();
	if (Buffer.isBuffer(value)) return `\\x${value.toString("hex", 0, 64)}${value.length > 64 ? "…" : ""}`;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "object") return JSON.stringify(value);
	return value;
};

const toResultSets = (result: QueryArrayResult | QueryArrayResult[]): ResultSet[] =>
	(Array.isArray(result) ? result : [result]).map((res) => ({
		command: res.command,
		rowCount: res.rowCount,
		columns: (res.fields || []).map((field) => field.name),
		rows: (res.rows || []).slice(0, UI_MAX_ROWS).map((row) => row.map(serializeCell)),
		truncated: (res.rows || []).length > UI_MAX_ROWS,
	}));

/**
 * The model gets a smaller copy of the results to keep the context small
 */
const resultsForModel = (results: ResultSet[]) => {
	let maxRows = MODEL_MAX_ROWS;
	const format = () =>
		JSON.stringify(
			results.map((result) => {
				const rows = result.rows.slice(0, maxRows).map((row) => row.map((cell) => (typeof cell === "string" && cell.length > MODEL_MAX_CELL ? cell.slice(0, MODEL_MAX_CELL) + "…" : cell)));
				const total = result.rowCount ?? result.rows.length;
				return {
					command: result.command,
					rowCount: result.rowCount,
					...(result.columns.length ? { columns: result.columns, rows } : {}),
					...(rows.length < total ? { note: `Only the first ${rows.length} of ${total} rows are shown, use aggregates or LIMIT/OFFSET to see more` } : {}),
				};
			})
		);
	let content = format();
	while (content.length > MODEL_MAX_CHARS && maxRows > 1) {
		maxRows = Math.floor(maxRows / 2);
		content = format();
	}
	return content;
};

const isMultipleStatementsError = (error: any) => error?.code === "42601" && /multiple commands/i.test(error?.message || "");

/**
 * Runs a single statement in a read only transaction, the extended protocol refuses multiple statements
 * so the SQL cannot end the transaction and keep going
 */
export async function readQuery(pool: Pool, sql: string, values: unknown[] = []) {
	const client = await pool.connect();
	try {
		await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
		await client.query("BEGIN READ ONLY");
		try {
			return await client.query({ text: sql, values, rowMode: "array", queryMode: "extended" } as any);
		} finally {
			await client.query("ROLLBACK").catch(() => undefined);
		}
	} finally {
		await client.query("RESET statement_timeout").catch(() => undefined);
		client.release();
	}
}

async function writeQuery(pool: Pool, sql: string) {
	const client = await pool.connect();
	try {
		await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
		return await client.query({ text: sql, rowMode: "array" } as any);
	} finally {
		await client.query("RESET statement_timeout").catch(() => undefined);
		client.release();
	}
}

const rowsToObjects = (result: QueryArrayResult) => result.rows.map((row) => Object.fromEntries(result.fields.map((field, i) => [field.name, serializeCell(row[i])])));

async function runQuery(ctx: ToolContext, pool: Pool, database: string, sql: string): Promise<ToolOutcome | typeof NEEDS_APPROVAL> {
	const display: ToolDisplay = { tool: "run_query", sql, database };
	const started = Date.now();

	let write = SIDE_EFFECT_FUNCTIONS.test(sql);
	if (!write) {
		try {
			const results = toResultSets(await readQuery(pool, sql));
			return { content: resultsForModel(results), display: { ...display, results, durationMs: Date.now() - started } };
		} catch (error: any) {
			// 25006: writes in a read only transaction, 25001: statements that can't run in a transaction
			if (error?.code === "25006" || error?.code === "25001" || isMultipleStatementsError(error)) {
				write = true;
			} else {
				return { content: JSON.stringify({ error: error.message }), display: { ...display, error: error.message, durationMs: Date.now() - started } };
			}
		}
	}

	display.write = true;
	if (ctx.writeMode === "read_only") {
		const message = "Changes are disabled in the assistant settings (read only), this query was not run. Tell the user what you would run instead.";
		return { content: JSON.stringify({ error: message }), display: { ...display, error: "Not run: changes are disabled (read only mode)" } };
	}
	if (ctx.writeMode === "ask" && ctx.approved === undefined) {
		return NEEDS_APPROVAL;
	}
	if (ctx.approved === false) {
		return {
			content: JSON.stringify({ error: "The user rejected this query, it was not run. Don't run it again unless the user asks." }),
			display: { ...display, rejected: true },
		};
	}

	const writeStarted = Date.now();
	try {
		const results = toResultSets(await writeQuery(pool, sql));
		return { content: resultsForModel(results), display: { ...display, results, durationMs: Date.now() - writeStarted } };
	} catch (error: any) {
		return { content: JSON.stringify({ error: error.message }), display: { ...display, error: error.message, durationMs: Date.now() - writeStarted } };
	}
}

export async function listTables(pool: Pool, schema?: string) {
	const result = await readQuery(
		pool,
		`SELECT n.nspname AS schema, c.relname AS name,
			CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS type,
			CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
			pg_size_pretty(pg_total_relation_size(c.oid)) AS size
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
			AND ($1::text IS NULL OR n.nspname = $1) AND NOT c.relispartition
		ORDER BY 1, 2 LIMIT 500`,
		[schema || null]
	);
	return rowsToObjects(result);
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function describeTable(pool: Pool, schema: string, table: string) {
	const [columns, constraints, indexes, info] = await Promise.all([
		readQuery(
			pool,
			`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
				pg_get_expr(d.adbin, d.adrelid) AS "default", col_description(c.oid, a.attnum) AS comment
			FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
			LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
			[schema, table]
		),
		readQuery(
			pool,
			`SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition
			FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = $1 AND c.relname = $2`,
			[schema, table]
		),
		readQuery(pool, `SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`, [schema, table]),
		readQuery(
			pool,
			`SELECT CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows, obj_description(c.oid, 'pg_class') AS comment
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
			[schema, table]
		),
	]);

	if (!columns.rows.length) {
		throw new Error(`Table "${schema}"."${table}" was not found, use list_tables to see the available tables`);
	}

	const sample = await readQuery(pool, `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 5`);
	return {
		schema,
		table,
		...(rowsToObjects(info)[0] || {}),
		columns: rowsToObjects(columns),
		constraints: rowsToObjects(constraints),
		indexes: rowsToObjects(indexes),
		sample: { columns: sample.fields.map((field) => field.name), rows: toResultSets(sample)[0].rows },
	};
}

export async function executeTool(name: string, args: any, ctx: ToolContext): Promise<ToolOutcome | typeof NEEDS_APPROVAL> {
	const fail = (message: string): ToolOutcome => ({ content: JSON.stringify({ error: message }), display: { tool: name, error: message } });

	try {
		// Tools that read or change data work on the named database, or the chat's database
		const target = () => ctx.resolvePool(typeof args?.database === "string" && args.database ? args.database : undefined);
		switch (name) {
			case "export_query_results": {
				if (typeof args?.sql !== "string" || !args.sql.trim()) return fail("sql is required");
				const { pool, database } = target();
				const format = args.format === "json" ? "json" : "csv";
				// Start the export once so a broken or non read query is reported now, not when the user clicks
				const rows = exportQuery(pool, args.sql, format);
				try {
					await rows.next();
				} finally {
					await rows.return(undefined);
				}
				return {
					content: JSON.stringify({ ok: true, message: `A download button for the ${format.toUpperCase()} export was shown to the user` }),
					display: { tool: name, database, sql: args.sql, text: `${format.toUpperCase()} export ready`, download: { kind: "export", database, sql: args.sql, format } },
				};
			}
			case "create_backup": {
				const { database } = target();
				const content = ["all", "schema", "data"].includes(args?.content) ? args.content : "all";
				return {
					content: JSON.stringify({ ok: true, message: `A download button for the backup of "${database}" was shown to the user, the backup is made when they click it` }),
					display: { tool: name, database, text: `Backup of ${database} ready`, download: { kind: "backup", database, content, gzip: args?.gzip === true } },
				};
			}
			case "list_databases": {
				const databases = await ctx.listDatabases();
				return {
					content: JSON.stringify({ current: ctx.database, count: databases.length, databases }),
					display: {
						tool: name,
						text: `${databases.length} databases`,
						results: [{ command: "LIST", rowCount: databases.length, columns: ["database"], rows: databases.map((database) => [database]), truncated: false }],
					},
				};
			}
			case "run_query": {
				if (typeof args?.sql !== "string" || !args.sql.trim()) return fail("sql is required");
				const { pool, database } = target();
				return await runQuery(ctx, pool, database, args.sql.trim());
			}
			case "list_tables": {
				const { pool, database } = target();
				const tables = await listTables(pool, args?.schema);
				// The count is given so small models don't have to count the list themselves
				return {
					content: JSON.stringify({ database, count: tables.length, tables }),
					display: {
						tool: name,
						database,
						text: `${tables.length} tables and views in ${database}${args?.schema ? `.${args.schema}` : ""}`,
						results: [
							{
								command: "LIST",
								rowCount: tables.length,
								columns: ["schema", "name", "type", "estimated rows", "size"],
								rows: tables.map((table: any) => [table.schema, table.name, table.type, table.estimated_rows, table.size]),
								truncated: false,
							},
						],
					},
				};
			}
			case "describe_table": {
				if (typeof args?.table !== "string") return fail("table is required");
				const { pool, database } = target();
				// Without a schema, the one the user works in (app/lib/db.ts)
				const schema = typeof args.schema === "string" && args.schema ? args.schema : (await pool.query("SELECT current_schema() AS schema")).rows[0]?.schema || "public";
				const description = { database, ...(await describeTable(pool, schema, args.table)) };
				return {
					content: resultsForModelSafe(description),
					display: {
						tool: name,
						database,
						text: `${database}: ${schema}.${args.table}, ${description.columns.length} columns`,
						results: [
							{
								command: "DESCRIBE",
								rowCount: description.columns.length,
								columns: ["name", "type", "nullable", "default"],
								rows: description.columns.map((column: any) => [column.name, column.type, column.nullable, column.default]),
								truncated: false,
							},
						],
					},
				};
			}
			case "save_memory": {
				if (typeof args?.content !== "string" || !args.content.trim()) return fail("content is required");
				const memory = await userDb.chatMemory.create({
					data: { content: args.content.trim().slice(0, 1000), database: ctx.database, connectionId: ctx.connectionId, userId: ctx.userId },
				});
				return { content: JSON.stringify({ saved: true, id: memory.id }), display: { tool: name, text: memory.content } };
			}
			case "forget_memory": {
				const { count } = await userDb.chatMemory.deleteMany({ where: { id: String(args?.id), userId: ctx.userId } });
				return count ? { content: JSON.stringify({ deleted: true }), display: { tool: name, text: "Memory deleted" } } : fail("Memory not found");
			}
			default:
				return fail(`Unknown tool ${name}`);
		}
	} catch (error: any) {
		return fail(error?.message || String(error));
	}
}

const resultsForModelSafe = (value: unknown) => {
	const content = JSON.stringify(value);
	return content.length > MODEL_MAX_CHARS ? content.slice(0, MODEL_MAX_CHARS) + "…(truncated)" : content;
};
