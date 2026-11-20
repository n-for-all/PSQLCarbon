import { Pool, PoolConfig } from 'pg';
import fs from "node:fs";
import type { ConnectionOptions } from "node:tls";
import isEqual from "fast-deep-equal";
import { Config, UserConnection } from "~/types";

interface ConnectionInfo {
	connectionName: string;
	pool: Pool;
	info: {
		whitelist: string[];
		blacklist: string[];
	};
}

/**
 * pg_tables condition for the tables the signed in role can read. Others, like a hosting provider's own tables,
 * are left out instead of failing with "permission denied" when opened. The schema is checked first because
 * has_table_privilege fails outright on a schema the role can't use.
 */
export const READABLE_TABLE = `
	schemaname NOT IN ('pg_catalog', 'information_schema')
	AND CASE WHEN has_schema_privilege(schemaname, 'USAGE') THEN has_table_privilege(format('%I.%I', schemaname, tablename), 'SELECT') ELSE false END`;

// Idle connections are kept for a minute, a remote server then doesn't need a new TLS handshake on every click
const IDLE_TIMEOUT_MS = 60_000;

// Without a chosen schema the role's own (usually public) is used when it has tables, otherwise the schema with the
// most tables, so a database that keeps everything in another schema opens there
const SCHEMA_SQL = `SELECT set_config('search_path', format('%I, public', s), false) FROM (
	SELECT schemaname AS s FROM pg_catalog.pg_tables WHERE ${READABLE_TABLE}
	GROUP BY schemaname ORDER BY schemaname IS NOT DISTINCT FROM current_schema() DESC, count(*) DESC, schemaname LIMIT 1
) t WHERE s IS DISTINCT FROM current_schema()`;

// The server can close an idle connection (a restart, or a hosted database going to sleep). The pool reports it
// here and replaces the connection on the next query, without a listener the error would stop the whole process.
const onIdleClientError = (error: Error) => {
	console.warn(`An idle database connection was closed: ${error.message}`);
};

/**
 * Pool settings for a connection. node-postgres reads sslmode=require as "verify the certificate", which fails on
 * the self-signed certificates many servers use, and its ssl settings from the connection string replace the ones
 * passed here. So the SSL parameters are taken out of the string and applied like psql (libpq) does:
 * require encrypts without checking the certificate, verify-ca checks it, verify-full also checks the host name.
 * The connection's own TLS options, when turned on, come last and win.
 */
export function poolConfigFor(connectionString: string, config: UserConnection): PoolConfig {
	let url: URL;
	try {
		url = new URL(connectionString);
	} catch {
		return { connectionString };
	}
	const params = url.searchParams;
	const mode = (params.get("sslmode") || (params.get("ssl") === "true" || params.get("ssl") === "1" ? "require" : "")).toLowerCase();
	const readFile = (name: string) => {
		const file = params.get(name);
		if (!file) return undefined;
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			throw new Error(`Could not read ${name} "${file}"`);
		}
	};
	const files = { ca: readFile("sslrootcert"), cert: readFile("sslcert"), key: readFile("sslkey") };
	for (const name of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) params.delete(name);

	let ssl: PoolConfig["ssl"] = false;
	if (mode === "verify-full") {
		ssl = { ...files, rejectUnauthorized: true };
	} else if (mode === "verify-ca") {
		// The certificate must be signed by a trusted authority, the host name isn't checked
		ssl = { ...files, rejectUnauthorized: true, checkServerIdentity: () => undefined };
	} else if (mode && mode !== "disable") {
		// require, no-verify, prefer and allow: encrypted, the certificate isn't checked
		ssl = { ...files, rejectUnauthorized: false };
	}

	if (config.tls) {
		const options: ConnectionOptions = {
			...(typeof ssl === "object" ? ssl : {}),
			rejectUnauthorized: !config.tlsAllowInvalidCertificates,
		};
		if (config.tlsCAFile) options.ca = config.tlsCAFile;
		if (config.tlsCertificateKeyFile) options.key = config.tlsCertificateKeyFile;
		if (config.tlsCertificateKeyFilePassword) options.passphrase = config.tlsCertificateKeyFilePassword;
		if (config.tlsAllowInvalidCertificates) options.checkServerIdentity = () => undefined;
		ssl = options;
	}

	return { connectionString: url.toString(), ssl };
}

class PgDbConnection {
	pools: { [dbName: string]: ConnectionInfo } = {};
	config: UserConnection;
	defaultDb: string = "";
	// The schema chosen for each database (app/routes/api.schema.ts), the others pick one themselves (SCHEMA_SQL)
	schemas: { [dbName: string]: string } = {};

	constructor(config: UserConnection) {
		this.config = config;
		try {
			const url = new URL(config.connectionString);
			this.defaultDb = url.pathname.replace(/^\//, '') || 'postgres';
		} catch (e) {
			this.defaultDb = 'postgres';
		}
	}

	init = async () => {
		const { connectionString } = this.config;
		try {
			const pool = this.createPool(this.defaultDb);
			// Test the connection
			const client = await pool.connect();
			client.release();
		} catch (error) {
			delete this.pools[this.defaultDb];
			console.error(`Could not connect to database using connectionString: ${connectionString.replace(/(postgres.*?:\/\/.*?:).*?@/, "$1****@")}"`);
			throw error;
		}
	};

	get listInfo() {
		const list = (value?: string | null) => (value ? value.split(",").map((d) => d.trim()).filter(Boolean) : []);
		return { whitelist: list(this.config.whitelist), blacklist: list(this.config.blacklist) };
	}

	isAllowed(dbName: string): boolean {
		const { whitelist, blacklist } = this.listInfo;
		if (whitelist.length > 0 && !whitelist.includes(dbName)) {
			return false;
		}
		return !blacklist.includes(dbName);
	}

	/**
	 * A pool for one database. Every new connection first sets its search_path to the chosen schema, so the tables,
	 * the query editor and the assistant all work in it without naming it. pg runs that before any other query.
	 */
	private createPool(dbName: string): Pool {
		const url = new URL(this.config.connectionString);
		url.pathname = `/${dbName}`;
		const pool = new Pool({
			...poolConfigFor(url.toString(), this.config),
			max: this.config.maxPoolSize || 10,
			idleTimeoutMillis: IDLE_TIMEOUT_MS,
		});
		pool.on("error", onIdleClientError);
		pool.on("connect", (client) => {
			const schema = this.schemas[dbName];
			const sql = schema ? `SELECT set_config('search_path', format('%I, public', $1::text), false)` : SCHEMA_SQL;
			client.query(sql, schema ? [schema] : []).catch((error: Error) => console.warn(`Could not set the schema: ${error.message}`));
		});
		this.pools[dbName] = { connectionName: this.config.name, pool, info: this.listInfo };
		return pool;
	}

	getPool(dbName?: string): Pool | undefined {
		// The default database comes from the connection string itself, explicitly requested ones must pass the whitelist/blacklist
		if (dbName && !this.isAllowed(dbName)) {
			return undefined;
		}
		const targetDb = dbName || this.defaultDb;
		if (this.pools[targetDb]) {
			return this.pools[targetDb].pool;
		}
		try {
			return this.createPool(targetDb);
		} catch (e) {
			console.error(`Failed to create pool for database ${targetDb}`, e);
			return undefined;
		}
	}

	/**
	 * Applies the schemas chosen in this session, a database whose schema changes gets new connections
	 */
	applySchemas = async (schemas: { [dbName: string]: string } = {}) => {
		const changed = [...new Set([...Object.keys(schemas), ...Object.keys(this.schemas)])].filter((dbName) => (schemas[dbName] || "") !== (this.schemas[dbName] || ""));
		if (!changed.length) return;
		this.schemas = { ...schemas };
		await Promise.all(
			changed.map(async (dbName) => {
				const info = this.pools[dbName];
				if (!info) return;
				delete this.pools[dbName];
				await info.pool.end().catch(() => undefined);
			})
		);
	};

	/**
	 * The tables of the schema in use, and every schema that has tables the role can read
	 */
	getCollections = async ({ dbName }): Promise<{ name: string; type: string }[]> => {
		return (await this.getSchemaTables(dbName)).tables.map((name) => ({ name, type: "collection" }));
	};

	getSchemaTables = async (dbName: string): Promise<{ schema: string; schemas: { name: string; tables: number }[]; tables: string[] }> => {
		const pool = this.getPool(dbName);
		if (!pool) return { schema: "", schemas: [], tables: [] };
		const res = await pool.query(`SELECT schemaname, tablename, current_schema() AS current FROM pg_catalog.pg_tables WHERE ${READABLE_TABLE} ORDER BY schemaname, tablename`);
		const counts = new Map<string, number>();
		for (const row of res.rows) counts.set(row.schemaname, (counts.get(row.schemaname) || 0) + 1);
		const schema = res.rows[0]?.current ?? (await pool.query("SELECT current_schema() AS current")).rows[0]?.current ?? "";
		return {
			schema,
			schemas: [...counts].map(([name, tables]) => ({ name, tables })),
			tables: res.rows.filter((row) => row.schemaname === schema).map((row) => row.tablename),
		};
	};

	getDatabasesWithDetails = async () => {
		const dbs = await this.getDatabases();
		return {
			databases: dbs.map(d => ({ name: d, sizeOnDisk: 0, empty: false })),
			ok: 1
		};
	};

	getDatabases = async () => {
		const defaultPoolInfo = this.pools[this.defaultDb];
		if (!defaultPoolInfo || !defaultPoolInfo.pool) {
			return [];
		}
		// Only databases the role may connect to, the others would only fail when opened
		const res = await defaultPoolInfo.pool.query("SELECT datname FROM pg_database WHERE datistemplate = false AND has_database_privilege(datname, 'CONNECT');");
		return res.rows.map((row) => row.datname).filter((dbName) => dbName && this.isAllowed(dbName));
	};

	close = async () => {
		await Promise.all(Object.values(this.pools).map((info) => info.pool.end().catch(() => undefined)));
		this.pools = {};
	};

	/**
	 * Closes this connection's pool for one database, PostgreSQL won't drop a database with open connections
	 */
	closePool = async (dbName: string) => {
		const info = this.pools[dbName];
		if (!info || dbName === this.defaultDb) return;
		delete this.pools[dbName];
		await info.pool.end().catch(() => undefined);
	};
}

declare global {
	var __dbConnections: { [key: string]: PgDbConnection } | undefined;
}

const globalConnections = global.__dbConnections || (global.__dbConnections = {});

/**
 * Returns the cached connection for a saved connection, connections are cached by id so they are never shared
 * between users, and recreated when the saved settings change.
 */
const connect = async ({ schemas, ...config }: UserConnection & { id: string; schemas?: { [dbName: string]: string } }): Promise<ConnectionData> => {
	const key = config.id;
	const cached = globalConnections[key];
	if (cached) {
		if (isEqual(cached.config, config)) {
			// Without schemas (the MCP server, app/lib/mcp.server.ts) the ones chosen in the app stay
			if (schemas) await cached.applySchemas(schemas);
			return cached;
		}
		delete globalConnections[key];
		await cached.close();
	}

	const connectionData = new PgDbConnection(config);
	connectionData.schemas = { ...(schemas || {}) };
	await connectionData.init();

	globalConnections[key] = connectionData;

	return connectionData;
};

/**
 * Checks that the connection settings work without caching the connection
 */
export const testConnection = async (config: UserConnection): Promise<void> => {
	const connectionData = new PgDbConnection(config);
	try {
		await connectionData.init();
	} finally {
		await connectionData.close();
	}
};

export type ConnectionData = PgDbConnection;

export default connect;
