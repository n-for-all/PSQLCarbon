import { Pool, PoolConfig } from 'pg';
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

// The server can close an idle connection (a restart, or a hosted database going to sleep). The pool reports it
// here and replaces the connection on the next query, without a listener the error would stop the whole process.
const onIdleClientError = (error: Error) => {
	console.warn(`An idle database connection was closed: ${error.message}`);
};

class PgDbConnection {
	pools: { [dbName: string]: ConnectionInfo } = {};
	config: UserConnection;
	defaultDb: string = "";

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
		const { connectionString, name } = this.config;
		
		const poolConfig: PoolConfig = {
			connectionString,
			max: this.config.maxPoolSize || 10,
			idleTimeoutMillis: IDLE_TIMEOUT_MS,
		};

		if (this.config.tls) {
			poolConfig.ssl = {
				rejectUnauthorized: !this.config.tlsAllowInvalidCertificates,
				ca: this.config.tlsCAFile,
				key: this.config.tlsCertificateKeyFile,
				passphrase: this.config.tlsCertificateKeyFilePassword,
			};
		}

		try {
			const pool = new Pool(poolConfig);
			pool.on("error", onIdleClientError);
			// Test the connection
			const client = await pool.connect();
			client.release();
			
			this.pools[this.defaultDb] = {
				connectionName: name,
				pool,
				info: {
					whitelist: this.config.whitelist ? this.config.whitelist.split(",").map((d) => d.trim()).filter(Boolean) : [],
					blacklist: this.config.blacklist ? this.config.blacklist.split(",").map((d) => d.trim()).filter(Boolean) : [],
				},
			};
		} catch (error) {
			console.error(`Could not connect to database using connectionString: ${connectionString.replace(/(postgres.*?:\/\/.*?:).*?@/, "$1****@")}"`);
			throw error;
		}
	};

	isAllowed(dbName: string): boolean {
		const { whitelist, blacklist } = this.pools[this.defaultDb]?.info || { whitelist: [], blacklist: [] };
		if (whitelist.length > 0 && !whitelist.includes(dbName)) {
			return false;
		}
		return !blacklist.includes(dbName);
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

		// Create a new pool for the requested database
		try {
			const url = new URL(this.config.connectionString);
			url.pathname = `/${targetDb}`;
			
			const poolConfig: PoolConfig = {
				connectionString: url.toString(),
				max: this.config.maxPoolSize || 10,
				idleTimeoutMillis: IDLE_TIMEOUT_MS,
			};

			if (this.config.tls) {
				poolConfig.ssl = {
					rejectUnauthorized: !this.config.tlsAllowInvalidCertificates,
					ca: this.config.tlsCAFile,
					key: this.config.tlsCertificateKeyFile,
					passphrase: this.config.tlsCertificateKeyFilePassword,
				};
			}

			const pool = new Pool(poolConfig);
			pool.on("error", onIdleClientError);
			this.pools[targetDb] = {
				connectionName: this.config.name,
				pool,
				info: this.pools[this.defaultDb]?.info || { whitelist: [], blacklist: [] }
			};
			return pool;
		} catch (e) {
			console.error(`Failed to create pool for database ${targetDb}`, e);
			return undefined;
		}
	}

	getCollections = async ({ dbName }) => {
		const pool = this.getPool(dbName);
		if (!pool) return [];
		const res = await pool.query(`SELECT tablename FROM pg_catalog.pg_tables WHERE ${READABLE_TABLE};`);
		return res?.rows.map(row => ({ name: row.tablename, type: 'collection' })) || [];
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
const connect = async (config: UserConnection & { id: string }): Promise<ConnectionData> => {
	const key = config.id;
	const cached = globalConnections[key];
	if (cached) {
		if (isEqual(cached.config, config)) {
			return cached;
		}
		delete globalConnections[key];
		await cached.close();
	}

	const connectionData = new PgDbConnection(config);
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
