import { Pool, PoolConfig, Client } from 'pg';
import { Config, UserConnection } from "~/types";

interface ConnectionInfo {
	connectionName: string;
	pool: Pool;
	info: {
		whitelist: string[];
		blacklist: string[];
	};
}

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
			// Test the connection
			const client = await pool.connect();
			client.release();
			
			this.pools[this.defaultDb] = {
				connectionName: name,
				pool,
				info: {
					whitelist: this.config.whitelist ? this.config.whitelist.trim().split(",").filter(Boolean) : [],
					blacklist: this.config.blacklist ? this.config.blacklist.trim().split(",").filter(Boolean) : [],
				},
			};
		} catch (error) {
			console.error(`Could not connect to database using connectionString: ${connectionString.replace(/(postgres.*?:\/\/.*?:).*?@/, "$1****@")}"`);
			throw error;
		}
	};

	getPool(dbName?: string): Pool | undefined {
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
		const res = await pool.query(`
            SELECT tablename 
            FROM pg_catalog.pg_tables 
            WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema';
        `);
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
		const databases: string[] = [];
		const defaultPoolInfo = this.pools[this.defaultDb];
		if (defaultPoolInfo && defaultPoolInfo.pool) {
			const whitelist = defaultPoolInfo.info.whitelist || [];
			const blacklist = defaultPoolInfo.info.blacklist || [];
			
			const res = await defaultPoolInfo.pool.query('SELECT datname FROM pg_database WHERE datistemplate = false;');
			const allDbs = res.rows.map(row => row.datname);

			for (let i = 0; i < allDbs.length; ++i) {
				const dbName = allDbs[i];
				if (dbName) {
					if (whitelist.length > 0 && !whitelist.includes(dbName)) {
						continue;
					}

					if (blacklist.length > 0 && blacklist.includes(dbName)) {
						continue;
					}

					databases.push(dbName);
				}
			}
		}
		return databases;
	};
}

declare global {
	var __dbConnections: { [key: string]: PgDbConnection } | undefined;
}

const globalConnections = global.__dbConnections || (global.__dbConnections = {});

const connect = async (config: UserConnection): Promise<ConnectionData> => {
	const key = config.connectionString;
	if (globalConnections[key]) {
		return globalConnections[key];
	}

	const connectionData = new PgDbConnection(config);
	await connectionData.init();
	
	globalConnections[key] = connectionData;

	return connectionData;
};

export type ConnectionData = PgDbConnection;

export default connect;
