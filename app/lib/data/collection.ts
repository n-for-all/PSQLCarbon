import { Config } from "../../types";
import { ConnectionData } from "../db.js";
import { bytesToSize, roughSizeOfObject, isValidCollectionName } from "~/utils/functions.js";
import { parseObjectId, toJsonString, bsonToString, toBSON, parseEJSON } from "~/utils/functions.server";

const ALLOWED_MIME_TYPES = new Set(["text/csv", "application/json"]);

const converters = {
    // If type == J, convert value as json document
    J(value: string) {
        return JSON.parse(value);
    },
    // If type == N, convert value to number
    N(value: string) {
        return Number(value);
    },
    // If type == O, convert value to ObjectId
    O(value: string | number) {
        return parseObjectId(value);
    },
    // If type == R, convert to RegExp
    R(value: string) {
        return new RegExp(value, "i");
    },
    U(value: string) {
        return value;
    },
    // if type == S, no conversion done
    S(value: string) {
        return value;
    },
};

export class Collection {

    config: Config;
    collectionName: string;
    pool: any;
    dbName: string;

    constructor(connectionData: ConnectionData, dbName: string, collectionName: string, config: Config) {
        this.config = config;
        this.pool = connectionData.getPool(dbName);
        this.collectionName = collectionName;
        this.dbName = dbName;
    }

    _getQuery = (query: { [x: string]: any }) => {
        const { key } = query;
        let { value } = query;
        if (key && value) {
            const type = query.type?.toUpperCase();
            if (!(type in converters)) {
                throw new Error("Invalid query type: " + type);
            }
            value = converters[type](value);
            return { [key]: value };
        }
        const { query: jsonQuery } = query;
        return jsonQuery || {};
    };

    _getSort = (query: { [x: string]: any }) => {
        const { sort } = query;
        if (sort) {
            const outSort: { [key: string]: string } = {};
            for (const i in sort) {
                outSort[i] = Number.parseInt(sort[i], 10) === -1 ? 'DESC' : 'ASC';
            }
            return outSort;
        }
        return {};
    };

    _getQueryOptions = (query: { [x: string]: any }) => {
        return {
            sort: this._getSort(query),
            limit: Number.parseInt(query.limit, 10) || 10,
            skip: query.skip ? Number.parseInt(query.skip, 10) || 0 : 0,
        };
    };

    _getItemsAndCount = async (itemQuery, queryOptions) => {
        let queryObj = this._getQuery(itemQuery);
        
        const keys = Object.keys(queryObj);
        const values = Object.values(queryObj);
        
        let whereClause = "";
        if (keys.length > 0) {
            whereClause = "WHERE " + keys.map((k, i) => `"${k}" = $${i + 1}`).join(" AND ");
        }

        let sortClause = "";
        const sortKeys = Object.keys(queryOptions.sort);
        if (sortKeys.length > 0) {
            sortClause = "ORDER BY " + sortKeys.map((k) => `"${k}" ${queryOptions.sort[k]}`).join(", ");
        }

        const query = `SELECT * FROM "${this.collectionName}" ${whereClause} ${sortClause} LIMIT $${keys.length + 1} OFFSET $${keys.length + 2}`;
        const countQuery = `SELECT COUNT(*) FROM "${this.collectionName}" ${whereClause}`;

        const [itemsRes, countRes] = await Promise.all([
            this.pool.query(query, [...values, queryOptions.limit, queryOptions.skip]),
            this.pool.query(countQuery, values)
        ]);

        return {
            items: itemsRes.rows,
            count: parseInt(countRes.rows[0].count),
        };
    };

    viewCollection = async (query: { [x: string]: any }) => {
        const queryOptions = this._getQueryOptions(query);
        const { items, count } = await this._getItemsAndCount(query, queryOptions);

        const docs = items;
        let docsColumns: string[] = [];
        try {
            const schemaRes = await this.pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_schema = 'public' AND table_name = $1
                ORDER BY ordinal_position;
            `, [this.collectionName]);
            if (schemaRes.rows.length > 0) {
                docsColumns = schemaRes.rows.map(r => r.column_name);
            }
        } catch (e) {
            console.error("Failed to fetch schema columns", e);
        }

        if (docsColumns.length === 0) {
            const columns: Array<string[]> = [];
            for (const i in items) {
                columns.push(Object.keys(items[i]));
            }
            docsColumns = columns.flat().filter((value, index, arr) => arr.indexOf(value) === index);
        }

        // Pagination
        const { limit, skip, sort } = queryOptions;
        const pagination = count > limit;

        let dbStats: any = {};
        try {
            const statsRes = await this.pool.query(`
                SELECT 
                    pg_total_relation_size(C.oid) as "storageSize",
                    pg_indexes_size(C.oid) as "indexSize",
                    S.seq_scan as "seqScans",
                    S.idx_scan as "idxScans",
                    S.n_tup_ins as "inserted",
                    S.n_tup_upd as "updated",
                    S.n_tup_del as "deleted",
                    S.n_live_tup as "liveTuples"
                FROM pg_class C
                LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace)
                LEFT JOIN pg_stat_user_tables S ON (S.relid = C.oid)
                WHERE C.relname = $1
                AND N.nspname NOT IN ('pg_catalog', 'information_schema');
            `, [this.collectionName]);
            if (statsRes.rows.length > 0) {
                dbStats = statsRes.rows[0];
            }
        } catch (e) {
            console.error("Failed to fetch table stats", e);
        }

        let indexes = [];
        try {
            const indexRes = await this.pool.query(`
                SELECT indexname as name, indexdef as definition
                FROM pg_indexes
                WHERE tablename = $1;
            `, [this.collectionName]);
            indexes = indexRes.rows;
        } catch (e) {
            console.error("Failed to fetch indexes", e);
        }

        let structure = [];
        try {
            const structureRes = await this.pool.query(`
                SELECT column_name as name, data_type as type, character_maximum_length as max_length, is_nullable, column_default as default_value
                FROM information_schema.columns 
                WHERE table_schema = 'public' AND table_name = $1
                ORDER BY ordinal_position;
            `, [this.collectionName]);
            structure = structureRes.rows;
        } catch (e) {
            console.error("Failed to fetch structure", e);
        }

        const ctx = {
            title: this.collectionName,
            docs,
            columns: docsColumns,
            count,
            stats: {
                storageStats: {
                    storageSize: parseInt(dbStats.storageSize) || 0,
                    totalIndexSize: parseInt(dbStats.indexSize) || 0,
                    totalSize: (parseInt(dbStats.storageSize) || 0) + (parseInt(dbStats.indexSize) || 0),
                },
                queryExecStats: {
                    seqScans: parseInt(dbStats.seqScans) || 0,
                    idxScans: parseInt(dbStats.idxScans) || 0,
                    inserted: parseInt(dbStats.inserted) || 0,
                    updated: parseInt(dbStats.updated) || 0,
                    deleted: parseInt(dbStats.deleted) || 0,
                    liveTuples: parseInt(dbStats.liveTuples) || 0,
                },
                ns: this.collectionName,
                host: "PostgreSQL",
                localTime: new Date().toISOString()
            },
            limit,
            skip,
            sort,
            pagination,
            key: query.key,
            value: query.value,
            type: query.type,
            query: query.query,
            projection: query.projection,
            runAggregate: false,
            indexes,
            structure,
        };

        return ctx;
    };

    getDbCollection = () => {
        return null;
    };

    getColumns = async () => {
        const res = await this.pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
            AND table_name   = $1;
        `, [this.collectionName]);

        return res.rows.map(row => row.column_name);
    };

    compactCollection = async () => {
        return await this.pool.query(`VACUUM "${this.collectionName}"`);
    };

    exportCollection = async (documentQuery: { [x: string]: any }) => {
        const { items } = await this._getItemsAndCount(documentQuery, this._getQueryOptions(documentQuery));
        return items;
    };

    exportColArray = async (documentQuery: { [x: string]: any }) => {
        const { items } = await this._getItemsAndCount(documentQuery, this._getQueryOptions(documentQuery));
        return toJsonString(items);
    };

    exportCsv = async (documentQuery: { [x: string]: any }) => {
        return this.exportColArray(documentQuery);
    };

    reIndex = async () => {
        return await this.pool.query(`REINDEX TABLE "${this.collectionName}"`);
    };

    addIndex = async (index) => {
        const indexName = `idx_${this.collectionName}_${Date.now()}`;
        return await this.pool.query(`CREATE INDEX "${indexName}" ON "${this.collectionName}" USING btree ("${index.key}")`);
    };

    createCollection = async (collectionName: string) => {
        const valid = isValidCollectionName(collectionName);
        if (!valid) {
            throw new Error("Invalid collection name");
        }
        return await this.pool.query(`CREATE TABLE "${collectionName}" (id SERIAL PRIMARY KEY)`);
    };

    deleteCollection = async (): Promise<boolean> => {
        await this.pool.query(`DROP TABLE "${this.collectionName}"`);
        return true;
    };

    deleteDocuments = async (documentQuery: { [x: string]: any }) => {
        let queryObj = this._getQuery(documentQuery);
        
        const keys = Object.keys(queryObj);
        const values = Object.values(queryObj);
        
        let whereClause = "";
        if (keys.length > 0) {
            whereClause = "WHERE " + keys.map((k, i) => `"${k}" = $${i + 1}`).join(" AND ");
        }

        const query = `DELETE FROM "${this.collectionName}" ${whereClause}`;
        return await this.pool.query(query, values);
    };

    renameCollection = async (newName: string) => {
        const valid = isValidCollectionName(newName);
        if (!valid) {
            throw new Error("Invalid collection name");
        }
        return await this.pool.query(`ALTER TABLE "${this.collectionName}" RENAME TO "${newName}"`);
    };

    dropIndex = async (indexName: string | undefined) => {
        if (!indexName) {
            throw new Error("The index you are deleting is invalid!");
        }
        return await this.pool.query(`DROP INDEX "${indexName}"`);
    };

    importCollection = async (files: Array<any>) => {
        // Simple implementation for importing to Postgres
        const areInvalidFiles = files.some((file) => !ALLOWED_MIME_TYPES.has(file.mimetype) || !file.data || !file.data.toString);
        if (areInvalidFiles) {
            throw new Error("Some of the files are invalid, Importing is aborted");
        }

        const docs: Array<any> = [];

        for (const file of files) {
            const fileContent = file.data.toString("utf8");
            const lines = fileContent
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
            for (const line of lines) {
                const parsedData = parseEJSON(line);
                docs.push(...(Array.isArray(parsedData) ? parsedData : [parsedData]));
            }
        }
        
        if (docs.length === 0) return { insertedCount: 0 };

        // For simplicity, inserting one by one
        let insertedCount = 0;
        for (const doc of docs) {
            const keys = Object.keys(doc);
            const values = Object.values(doc);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
            
            await this.pool.query(
                `INSERT INTO "${this.collectionName}" ("${keys.join('", "')}") VALUES (${placeholders})`,
                values
            );
            insertedCount++;
        }
        
        return { insertedCount };
    };

    async configureQueryAnalyzer(options: { mode: string; samplesPerSecond?: number }) {
        throw new Error("Not implemented for PostgreSQL");
    }

    async getShardDistribution() {
        return [];
    }

    async getShardVersion() {
        return null;
    }

    async stats() {
        return {};
    }

    async totalIndexSize() {
        return 0;
    }

    async totalSize() {
        return 0;
    }

    async validate(options: { full?: boolean; repair?: boolean; checkBSONConformance?: boolean }) {
        return {};
    }

    async storageSize() {
        return 0;
    }

    async callFunction(functionName, ...args) {
        if (typeof this[functionName] === "function") {
            return this[functionName](...args);
        }
        throw new Error(`${functionName} is not a function`);
    }
}
