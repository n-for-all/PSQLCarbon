import { Config } from "~/types";
import { ConnectionData } from "../db.js";
import { bytesToSize, isValidCollectionName, isValidDatabaseName } from "~/utils/functions";

export class Database {
    config: Config;
    connectionData: ConnectionData;
    constructor(connectionData: ConnectionData, config: Config) {
        this.config = config;
        this.connectionData = connectionData;
    }

    createDocument = async (dbName: string, collectionName: string, document: any) => {
        if (!isValidCollectionName(collectionName)) {
            return Promise.reject(new Error(`The table name "${collectionName}" is invalid`));
        }
        const pool = this.connectionData.getPool(dbName);
        if (!pool) return Promise.reject(new Error("No database connection pool available"));
        
        const keys = Object.keys(document);
        const values = Object.values(document);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        
        const query = `INSERT INTO "${collectionName}" ("${keys.join('", "')}") VALUES (${placeholders}) RETURNING *`;
        const result = await pool.query(query, values);
        return result.rows[0];
    };

    deleteDocument = async (dbName: string, collectionName: string, documentId: string) => {
        if (!isValidCollectionName(collectionName)) {
            return Promise.reject(new Error(`The table name "${collectionName}" is invalid`));
        }
        const pool = this.connectionData.getPool(dbName);
        if (!pool) return Promise.reject(new Error("No database connection pool available"));

        // Assumes id is the primary key and is named 'id'
        const query = `DELETE FROM "${collectionName}" WHERE id = $1 RETURNING *`;
        const result = await pool.query(query, [documentId]);
        return result.rows[0];
    };

    getCollections = async (dbName: string) => {
        const pool = this.connectionData.getPool(dbName);
        if (!pool) return Promise.reject(new Error("No database connection pool available"));
        
        const res = await pool.query(`
            SELECT tablename 
            FROM pg_catalog.pg_tables 
            WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema';
        `);
        return res.rows.map(row => ({ collectionName: row.tablename }));
    };

    getDocuments = async (dbName: string, collectionName: string, queryObj: object = {}, limit: number = 50, skip: number = 0) => {
        if (!isValidCollectionName(collectionName)) {
            return Promise.reject(new Error(`The table name "${collectionName}" is invalid`));
        }
        const pool = this.connectionData.getPool(dbName);
        if (!pool) return Promise.reject(new Error("No database connection pool available"));

        const keys = Object.keys(queryObj);
        const values = Object.values(queryObj);
        
        let whereClause = "";
        if (keys.length > 0) {
            whereClause = "WHERE " + keys.map((k, i) => `"${k}" = $${i + 1}`).join(" AND ");
        }

        const query = `SELECT * FROM "${collectionName}" ${whereClause} LIMIT $${keys.length + 1} OFFSET $${keys.length + 2}`;
        const result = await pool.query(query, [...values, limit, skip]);
        return result.rows;
    };

    getStats = async (dbOName: string) => {
        const listDatabases = await this.connectionData.getDatabases();
        let dbName = "";
        let found = listDatabases.some((db) => {
            if (dbOName == db) {
                dbName = db;
                return true;
            }
        });

        if (!found) {
            throw new Error("Database not found");
        }

        const pool = this.connectionData.getPool(dbName);
        if (!pool) return null;

        const dbStatsRes = await pool.query(`
            SELECT pg_database_size($1) as dataSize;
        `, [dbName]);

        const tablesRes = await pool.query(`
            SELECT 
                C.relname as name,
                COALESCE(S.n_live_tup, 0) as count,
                pg_total_relation_size(C.oid) as "storageSize",
                pg_indexes_size(C.oid) as "indexSize",
                (SELECT count(*) FROM pg_index WHERE indrelid = C.oid) as "indexCount"
            FROM pg_class C
            LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace)
            LEFT JOIN pg_stat_user_tables S ON (S.relid = C.oid)
            WHERE N.nspname NOT IN ('pg_catalog', 'information_schema')
            AND C.relkind = 'r'
            ORDER BY C.relname;
        `);

        let totalObjects = 0;
        let totalIndexes = 0;
        let totalIndexSize = 0;
        let totalStorageSize = 0;

        let collectionList = tablesRes.rows.map(row => {
            const count = parseInt(row.count) || 0;
            const storageSize = parseInt(row.storageSize) || 0;
            const indexSize = parseInt(row.indexSize) || 0;
            const indexCount = parseInt(row.indexCount) || 0;

            totalObjects += count;
            totalIndexes += indexCount;
            totalIndexSize += indexSize;
            totalStorageSize += storageSize;

            return {
                name: row.name,
                count: count,
                indexes: [],
                storageSize: storageSize,
                stats: {
                    latencyStats: {
                        reads: { histogram: [], latency: 0, ops: 0 },
                        writes: { histogram: [], latency: 0, ops: 0 },
                        commands: { histogram: [], latency: 0, ops: 0 },
                        transactions: { histogram: [], latency: 0, ops: 0 },
                    },
                    storageStats: {
                        storageSize: storageSize,
                        totalIndexSize: indexSize,
                        totalSize: storageSize,
                    },
                    queryExecStats: {
                        collectionScans: { total: 0, nonTailable: 0 }
                    },
                    ns: row.name,
                    host: "PostgreSQL",
                    localTime: new Date().toISOString()
                }
            };
        });

        return {
            name: dbName,
            collections: collectionList.length,
            collectionList: collectionList,
            dataSize: bytesToSize(parseInt(dbStatsRes.rows[0].datasize) || 0),
            storageSize: bytesToSize(totalStorageSize),
            objects: totalObjects,
            indexes: totalIndexes,
            indexSize: bytesToSize(totalIndexSize),
            avgObjSize: totalObjects > 0 ? bytesToSize(Math.round(totalStorageSize / totalObjects)) : "0 Bytes",
            
            // Clean up nulls to keep TypeScript happy
            fsUsedSize: null,
            fsTotalSize: null,
            operationTime: null,
            clusterTime: null,
            views: 0,
            dataFileVersion: null,
            extentFreeListNum: null,
            fileSize: null,
            numExtents: null,
        };
    };

    createDatabase = async (dbName: string, collectionName: string) => {
        if (!isValidCollectionName(collectionName)) {
            return Promise.reject(new Error(`The table name "${collectionName}" is invalid`));
        }
        
        const defaultPool = this.connectionData.getPool();
        if (!defaultPool) return Promise.reject(new Error("No default database connection pool available"));

        try {
            await defaultPool.query(`CREATE DATABASE "${dbName}"`);
        } catch (e: any) {
            if (e.code !== '42P04') { // 42P04 is duplicate_database
                throw e;
            }
        }

        const pool = this.connectionData.getPool(dbName);
        if (!pool) return Promise.reject(new Error("No database connection pool available"));

        const query = `CREATE TABLE IF NOT EXISTS "${collectionName}" (id SERIAL PRIMARY KEY)`;
        return await pool.query(query);
    };

    deleteDatabase = async (dbName: string) => {
        throw new Error("Dropping database is not fully supported without switching connection. You may want to DROP TABLE instead.");
    };
}
