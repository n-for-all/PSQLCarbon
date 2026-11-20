import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { to as copyTo } from "pg-copy-streams";
import type { UserConnection } from "~/types";

/**
 * Backups use pg_dump when it can run on the server and is new enough for the database server,
 * otherwise the built-in engine writes a plain SQL file from the catalog. Both work on the web
 * and in the desktop app, the built-in one needs nothing installed.
 */

export type BackupContent = "all" | "schema" | "data";

export interface PgTool {
	path: string;
	version: string;
	major: number;
}

const TOOL_DIRS = [
	"/Applications/Postgres.app/Contents/Versions/latest/bin",
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
];

// Versioned install folders, e.g. /usr/lib/postgresql/16/bin or C:\Program Files\PostgreSQL\16\bin
const VERSIONED_ROOTS = [
	"/Applications/Postgres.app/Contents/Versions",
	"/usr/lib/postgresql",
	"/opt/homebrew/opt",
	"/usr/local/opt",
	"C:\\Program Files\\PostgreSQL",
];

const runVersion = (file: string) =>
	new Promise<string | null>((resolve) => {
		execFile(file, ["--version"], { timeout: 3000, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim()));
	});

const candidates = (name: string) => {
	const exe = process.platform === "win32" ? `${name}.exe` : name;
	// The desktop app ships its own pg_dump and pg_restore (scripts/fetch-pg-tools.mjs), electron/main.js points here
	const bundled = process.env.PSQLCARBON_PG_TOOLS ? [path.join(process.env.PSQLCARBON_PG_TOOLS, exe)] : [];
	// The App Sandbox only lets the desktop app run programs inside its own bundle, every desktop build uses just those
	if (process.env.PSQLCARBON_DESKTOP === "1") return bundled;
	const files = new Set<string>([...bundled, exe]);
	for (const dir of TOOL_DIRS) files.add(path.join(dir, exe));
	for (const root of VERSIONED_ROOTS) {
		try {
			for (const entry of fs.readdirSync(root)) {
				// postgresql@16 (Homebrew), 16 (apt, Windows, Postgres.app)
				if (/^(postgresql@)?\d+(\.\d+)?$/.test(entry)) files.add(path.join(root, entry, "bin", exe));
			}
		} catch {
			// not installed there
		}
	}
	return [...files];
};

const toolCache = new Map<string, { at: number; tool: PgTool | null }>();

/**
 * Finds the newest working copy of a PostgreSQL client tool, a tool only counts when it actually runs here
 */
export async function findPgTool(name: "pg_dump" | "pg_restore"): Promise<PgTool | null> {
	const cached = toolCache.get(name);
	if (cached && Date.now() - cached.at < 60_000) return cached.tool;

	let best: PgTool | null = null;
	for (const file of candidates(name)) {
		const output = await runVersion(file);
		const match = output?.match(/(\d+)(?:\.(\d+))?/);
		if (!match) continue;
		const tool = { path: file, version: output!.replace(/^.*?\(PostgreSQL\)\s*/, ""), major: Number(match[1]) };
		if (!best || tool.major > best.major) best = tool;
	}
	toolCache.set(name, { at: Date.now(), tool: best });
	return best;
}

export async function serverVersion(pool: Pool) {
	const result = await pool.query("SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS version");
	return { major: Math.floor(result.rows[0].num / 10000), version: String(result.rows[0].version) };
}

/**
 * Environment for running pg tools against a database, the password goes in the environment, not the arguments
 */
export function toolEnvironment(connection: UserConnection, database: string) {
	const url = new URL(connection.connectionString);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PGHOST: url.searchParams.get("host") || url.hostname || "localhost",
		PGPORT: url.port || "5432",
		PGUSER: decodeURIComponent(url.username),
		PGDATABASE: database,
		PGCONNECT_TIMEOUT: "10",
	};
	if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
	const sslmode = url.searchParams.get("sslmode");
	// "no-verify" is node-postgres only, for pg_dump and pg_restore it's "require"
	if (sslmode) env.PGSSLMODE = sslmode === "no-verify" ? "require" : sslmode;
	let cleanup = () => {};
	if (connection.tls) {
		env.PGSSLMODE = connection.tlsAllowInvalidCertificates ? "require" : "verify-full";
		if (connection.tlsCAFile) {
			const file = path.join(os.tmpdir(), `psqlcarbon-ca-${process.pid}-${Date.now()}.pem`);
			fs.writeFileSync(file, connection.tlsCAFile, { mode: 0o600 });
			env.PGSSLROOTCERT = file;
			cleanup = () => fs.rmSync(file, { force: true });
		}
	}
	return { env, cleanup };
}

/**
 * Streams pg_dump output, resolves once the first output arrives so startup errors can still be reported as an error response
 */
export function pgDumpStream(tool: PgTool, connection: UserConnection, database: string, options: { content: BackupContent; format: "plain" | "custom" }) {
	const { env, cleanup } = toolEnvironment(connection, database);
	const args = ["--no-owner", "--no-privileges", `--format=${options.format === "custom" ? "custom" : "plain"}`];
	if (options.content === "schema") args.push("--schema-only");
	if (options.content === "data") args.push("--data-only");
	const child = spawn(tool.path, args, { env, windowsHide: true });

	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
	child.on("close", cleanup);

	return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
		let started = false;
		child.once("error", reject);
		child.on("close", (code) => {
			if (!started) reject(new Error(stderr.trim() || `pg_dump exited with code ${code}`));
		});
		child.stdout.once("readable", () => {
			started = true;
			resolve(
				new ReadableStream({
					start(controller) {
						child.stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
						child.on("close", (code) => {
							if (code !== 0) controller.enqueue(new TextEncoder().encode(options.format === "plain" ? `\n-- pg_dump failed: ${stderr.trim()}\n` : ""));
							controller.close();
						});
					},
					cancel() {
						child.kill();
					},
				})
			);
		});
	});
}

// ---------------------------------------------------------------------------------------------
// Built-in engine

const USER_NAMESPACES = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;
// Objects that belong to an extension are created by CREATE EXTENSION
const NOT_EXTENSION = (catalog: string, column: string) =>
	`NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${column} AND d.deptype = 'e')`;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qualified = (schema: string, name: string) => `${ident(schema)}.${ident(name)}`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

interface TableInfo {
	oid: number;
	schema: string;
	name: string;
	kind: string;
	persistence: string;
	isPartition: boolean;
	partitionBound: string | null;
	partitionKey: string | null;
	parent: string | null;
	comment: string | null;
}

/**
 * Orders items so each comes after the items it depends on, cycles keep their original order
 */
function topologicalSort<T>(items: T[], key: (item: T) => string, dependencies: Map<string, Set<string>>) {
	const byKey = new Map(items.map((item) => [key(item), item]));
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const sorted: T[] = [];
	const visit = (k: string) => {
		if (visited.has(k) || visiting.has(k) || !byKey.has(k)) return;
		visiting.add(k);
		for (const dependency of dependencies.get(k) || []) visit(dependency);
		visiting.delete(k);
		visited.add(k);
		sorted.push(byKey.get(k)!);
	};
	for (const item of items) visit(key(item));
	return sorted;
}

/**
 * Writes a plain SQL backup of a database. Everything is read in one repeatable read snapshot, so
 * the backup is consistent even while the database is in use.
 */
export async function* builtinDump(pool: Pool, database: string, content: BackupContent): AsyncGenerator<string> {
	const client: PoolClient = await pool.connect();
	try {
		await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
		// Definitions come out fully qualified with an empty search path, like pg_dump
		await client.query("SET LOCAL search_path = ''");
		const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
		const version = (await q("SELECT current_setting('server_version') AS v"))[0].v;

		const skipped: string[] = [];
		const counts = (
			await q(`SELECT
				(SELECT count(*) FROM pg_policy)::int AS policies,
				(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prokind IN ('a', 'w') AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_proc", "p.oid")})::int AS aggregates,
				(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_inherits i ON i.inhrelid = c.oid WHERE NOT c.relispartition AND ${USER_NAMESPACES})::int AS inherited`)
		)[0];
		if (counts.policies) skipped.push(`${counts.policies} row level security policies`);
		if (counts.aggregates) skipped.push(`${counts.aggregates} custom aggregates`);
		if (counts.inherited) skipped.push(`table inheritance of ${counts.inherited} tables (they are restored as standalone tables)`);
		skipped.push("ownership and privileges (GRANT/REVOKE)");

		yield `--
-- PSQLCarbon backup of database "${database}"
-- Created ${new Date().toISOString()} from PostgreSQL ${version}
-- Content: ${content === "all" ? "schema and data" : content === "schema" ? "schema only" : "data only"}
-- Not included: ${skipped.join(", ")}
--
-- Restore it with PSQLCarbon (Backup & Restore) or psql: psql -d <database> -f <this file>
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', '', false);

`;

		const tables: TableInfo[] = (
			await q(
				`SELECT c.oid::int, n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence, c.relispartition AS is_partition,
					CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END AS partition_bound,
					CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key,
					(SELECT pn.nspname || '.' || pc.relname FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE i.inhrelid = c.oid AND c.relispartition) AS parent,
					(SELECT quote_ident(pn.nspname) || '.' || quote_ident(pc.relname) FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE i.inhrelid = c.oid AND c.relispartition) AS parent_sql,
					obj_description(c.oid, 'pg_class') AS comment
				FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind IN ('r', 'p') AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_class", "c.oid")}
				ORDER BY c.relispartition, c.oid`
			)
		).map((row) => ({
			oid: row.oid,
			schema: row.schema,
			name: row.name,
			kind: row.kind,
			persistence: row.persistence,
			isPartition: row.is_partition,
			partitionBound: row.partition_bound,
			partitionKey: row.partition_key,
			parent: row.parent_sql,
			comment: row.comment,
		}));

		const columns = await q(
			`SELECT a.attrelid::int AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
				a.attidentity AS identity, a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS default,
				CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = a.attcollation) END AS collation,
				col_description(a.attrelid, a.attnum) AS comment
			FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attrelid, a.attnum`,
			[tables.map((table) => table.oid)]
		);
		const columnsOf = (table: TableInfo) => columns.filter((column) => column.table === table.oid);

		if (content !== "data") {
			// Schemas, extensions and types
			for (const row of await q(`SELECT n.nspname AS name FROM pg_namespace n WHERE ${USER_NAMESPACES} AND n.nspname <> 'public' AND ${NOT_EXTENSION("pg_namespace", "n.oid")} ORDER BY n.oid`)) {
				yield `CREATE SCHEMA IF NOT EXISTS ${ident(row.name)};\n`;
			}
			for (const row of await q(`SELECT e.extname AS name, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY e.oid`)) {
				yield `CREATE EXTENSION IF NOT EXISTS ${ident(row.name)} WITH SCHEMA ${ident(row.schema)};\n`;
			}
			yield "\n";

			for (const row of await q(
				`SELECT n.nspname AS schema, t.typname AS name, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
				FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
				WHERE ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_type", "t.oid")} GROUP BY 1, 2, t.oid ORDER BY t.oid`
			)) {
				yield `CREATE TYPE ${qualified(row.schema, row.name)} AS ENUM (${row.labels});\n`;
			}
			for (const row of await q(
				`SELECT n.nspname AS schema, t.typname AS name, format_type(t.typbasetype, t.typtypmod) AS base, t.typnotnull AS not_null, t.typdefault AS default,
					(SELECT string_agg(' CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid), '' ORDER BY c.oid) FROM pg_constraint c WHERE c.contypid = t.oid) AS constraints
				FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
				WHERE t.typtype = 'd' AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_type", "t.oid")} ORDER BY t.oid`
			)) {
				yield `CREATE DOMAIN ${qualified(row.schema, row.name)} AS ${row.base}${row.default ? ` DEFAULT ${row.default}` : ""}${row.not_null ? " NOT NULL" : ""}${row.constraints || ""};\n`;
			}
			for (const row of await q(
				`SELECT n.nspname AS schema, t.typname AS name,
					(SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) AS attributes
				FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_class c ON c.oid = t.typrelid
				WHERE t.typtype = 'c' AND c.relkind = 'c' AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_type", "t.oid")} ORDER BY t.oid`
			)) {
				yield `CREATE TYPE ${qualified(row.schema, row.name)} AS (${row.attributes});\n`;
			}

			// Sequences, identity sequences are created with their column
			for (const row of await q(
				`SELECT n.nspname AS schema, c.relname AS name, format_type(s.seqtypid, NULL) AS type, s.seqstart AS start, s.seqincrement AS increment,
					s.seqmin AS min, s.seqmax AS max, s.seqcache AS cache, s.seqcycle AS cycle
				FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_class", "c.oid")}
					AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'i')
				ORDER BY c.oid`
			)) {
				yield `CREATE SEQUENCE ${qualified(row.schema, row.name)} AS ${row.type} START WITH ${row.start} INCREMENT BY ${row.increment} MINVALUE ${row.min} MAXVALUE ${row.max} CACHE ${row.cache}${row.cycle ? " CYCLE" : ""};\n`;
			}
			yield "\n";

			// Functions and procedures, bodies aren't checked so their order doesn't matter. Functions whose
			// arguments or result use a table's row type have to wait until the tables exist.
			const functions = await q(
				`SELECT pg_get_functiondef(p.oid) AS def,
					EXISTS (
						SELECT 1 FROM unnest(array_append(coalesce(p.proallargtypes, p.proargtypes::oid[]), p.prorettype)) AS u(type)
						JOIN pg_type ty ON ty.oid = u.type LEFT JOIN pg_type el ON el.oid = ty.typelem
						JOIN pg_class rel ON rel.oid IN (ty.typrelid, el.typrelid) WHERE rel.relkind <> 'c'
					) AS uses_tables
				FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
				WHERE p.prokind IN ('f', 'p') AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_proc", "p.oid")} ORDER BY p.oid`
			);
			for (const row of functions.filter((row) => !row.uses_tables)) {
				yield `${row.def.trim()};\n\n`;
			}

			// Tables, keys and indexes are added after the data
			for (const table of tables) {
				const name = qualified(table.schema, table.name);
				if (table.isPartition && table.parent) {
					yield `CREATE TABLE ${name} PARTITION OF ${table.parent} ${table.partitionBound};\n\n`;
					continue;
				}
				const definitions = columnsOf(table).map((column) => {
					let line = `    ${ident(column.name)} ${column.type}`;
					if (column.collation) line += ` COLLATE ${column.collation}`;
					if (column.generated === "s") line += ` GENERATED ALWAYS AS (${column.default}) STORED`;
					else if (column.identity) line += ` GENERATED ${column.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
					else if (column.default) line += ` DEFAULT ${column.default}`;
					if (column.not_null) line += " NOT NULL";
					return line;
				});
				yield `CREATE ${table.persistence === "u" ? "UNLOGGED " : ""}TABLE ${name} (\n${definitions.join(",\n")}\n)${table.partitionKey ? ` PARTITION BY ${table.partitionKey}` : ""};\n\n`;
			}

			// Serial sequences belong to their column
			for (const row of await q(
				`SELECT sn.nspname AS seq_schema, s.relname AS seq_name, tn.nspname AS schema, t.relname AS table, a.attname AS column
				FROM pg_depend d JOIN pg_class s ON s.oid = d.objid JOIN pg_namespace sn ON sn.oid = s.relnamespace
				JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
				WHERE d.classid = 'pg_class'::regclass AND s.relkind = 'S' AND d.deptype = 'a' AND ${USER_NAMESPACES.replace(/n\.nspname/g, "sn.nspname")}`
			)) {
				yield `ALTER SEQUENCE ${qualified(row.seq_schema, row.seq_name)} OWNED BY ${qualified(row.schema, row.table)}.${ident(row.column)};\n`;
			}
			yield "\n";

			for (const row of functions.filter((row) => row.uses_tables)) {
				yield `${row.def.trim()};\n\n`;
			}

			// Views in dependency order, materialized views are filled after the data
			const views = await q(
				`SELECT c.oid::int, n.nspname AS schema, c.relname AS name, c.relkind AS kind, pg_get_viewdef(c.oid) AS def
				FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind IN ('v', 'm') AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_class", "c.oid")} ORDER BY c.oid`
			);
			const viewDependencies = new Map<string, Set<string>>();
			for (const row of await q(
				`SELECT DISTINCT r.ev_class::int AS view, d.refobjid::int AS dependency FROM pg_rewrite r JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
				WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid <> r.ev_class`
			)) {
				if (!viewDependencies.has(String(row.view))) viewDependencies.set(String(row.view), new Set());
				viewDependencies.get(String(row.view))!.add(String(row.dependency));
			}
			for (const view of topologicalSort(views, (row) => String(row.oid), viewDependencies)) {
				const definition = view.def.trim().replace(/;$/, "");
				yield view.kind === "m"
					? `CREATE MATERIALIZED VIEW ${qualified(view.schema, view.name)} AS\n${definition}\nWITH NO DATA;\n\n`
					: `CREATE VIEW ${qualified(view.schema, view.name)} AS\n${definition};\n\n`;
			}
		}

		if (content !== "schema") {
			// Data only backups go into existing tables, so parents are filled before the tables referencing them
			let dataTables = tables.filter((table) => table.kind === "r");
			if (content === "data") {
				const references = new Map<string, Set<string>>();
				for (const row of await q(`SELECT conrelid::int AS child, confrelid::int AS parent FROM pg_constraint WHERE contype = 'f' AND conrelid <> confrelid`)) {
					if (!references.has(String(row.child))) references.set(String(row.child), new Set());
					references.get(String(row.child))!.add(String(row.parent));
				}
				dataTables = topologicalSort(dataTables, (table) => String(table.oid), references);
			}

			for (const table of dataTables) {
				const insertable = columnsOf(table).filter((column) => !column.generated);
				if (!insertable.length) continue;
				const name = qualified(table.schema, table.name);
				const columnList = insertable.map((column) => ident(column.name)).join(", ");
				// COPY is Postgres's bulk format, the same pg_dump writes: fast, and Postgres escapes every value itself.
				// COPY FROM also fills GENERATED ALWAYS identity columns, so no OVERRIDING clause is needed.
				yield `-- Data for ${name}\nCOPY ${name} (${columnList}) FROM stdin;\n`;
				const rows = client.query(copyTo(`COPY (SELECT ${columnList} FROM ONLY ${name}) TO STDOUT`));
				// Chunks can split a multi byte character, the decoder keeps the rest for the next one
				const decoder = new TextDecoder();
				for await (const chunk of rows as AsyncIterable<Buffer>) {
					const text = decoder.decode(chunk, { stream: true });
					if (text) yield text;
				}
				const rest = decoder.decode();
				if (rest) yield rest;
				yield "\\.\n";
				yield "\n";
			}

			// Sequences continue where they were
			for (const row of await q(
				`SELECT n.nspname AS schema, c.relname AS name,
					(SELECT quote_ident(tn.nspname) || '.' || quote_ident(t.relname) FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'i') AS identity_table,
					(SELECT a.attname FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'i') AS identity_column
				FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'S' AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_class", "c.oid")}`
			)) {
				const state = (await client.query(`SELECT last_value, is_called FROM ${qualified(row.schema, row.name)}`)).rows[0];
				const sequence = row.identity_table
					? `pg_catalog.pg_get_serial_sequence(${literal(row.identity_table)}, ${literal(row.identity_column)})`
					: literal(qualified(row.schema, row.name));
				yield `SELECT pg_catalog.setval(${sequence}, ${state.last_value}, ${state.is_called});\n`;
			}
			yield "\n";
		}

		if (content !== "data") {
			// Keys and checks, then indexes, then foreign keys
			const constraints = await q(
				`SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS def
				FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE con.contype IN ('p', 'u', 'c', 'x', 'f') AND con.conparentid = 0 AND con.conislocal AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_class", "c.oid")}
				ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'x' THEN 2 WHEN 'c' THEN 3 ELSE 4 END, con.oid`
			);
			const addConstraint = (row: any) => `ALTER TABLE ${qualified(row.schema, row.table)} ADD CONSTRAINT ${ident(row.name)} ${row.def};\n`;
			for (const row of constraints.filter((row) => row.type !== "f")) yield addConstraint(row);
			yield "\n";

			for (const row of await q(
				`SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE ${USER_NAMESPACES} AND c.relkind IN ('r', 'p', 'm') AND ${NOT_EXTENSION("pg_class", "c.oid")}
					AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
					AND NOT EXISTS (SELECT 1 FROM pg_inherits inh WHERE inh.inhrelid = i.indexrelid)
				ORDER BY i.indexrelid`
			)) {
				// An index on a partitioned table is defined ON ONLY the parent, created normally it covers every partition
				yield `${row.def.replace(/ ON ONLY /, " ON ")};\n`;
			}
			yield "\n";

			for (const row of constraints.filter((row) => row.type === "f")) yield addConstraint(row);
			yield "\n";

			for (const row of await q(
				`SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE NOT t.tgisinternal AND t.tgparentid = 0 AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_class", "c.oid")} ORDER BY t.oid`
			)) {
				yield `${row.def};\n`;
			}

			for (const row of await q(
				`SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind = 'm' AND c.relispopulated AND ${USER_NAMESPACES} AND ${NOT_EXTENSION("pg_class", "c.oid")} ORDER BY c.oid`
			)) {
				if (content === "all") yield `REFRESH MATERIALIZED VIEW ${qualified(row.schema, row.name)};\n`;
			}

			for (const table of tables) {
				const name = qualified(table.schema, table.name);
				if (table.comment) yield `COMMENT ON TABLE ${name} IS ${literal(table.comment)};\n`;
				for (const column of columnsOf(table)) {
					if (column.comment) yield `COMMENT ON COLUMN ${name}.${ident(column.name)} IS ${literal(column.comment)};\n`;
				}
			}
		}

		yield `\n-- Backup complete\n`;
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		// Closed instead of going back to the pool, the session settings were changed
		client.release(true);
	}
}
