import type { Pool } from "pg";
import { MAX_TABLES, type DiagramRelation, type DiagramSchema, type DiagramTable } from "./schema-diagram";

/**
 * Tables, columns, keys and declared foreign keys of one schema, for the relations diagram
 */
export async function loadDiagramSchema(pool: Pool, requested: string | null): Promise<DiagramSchema> {
    const schemas = (
        await pool.query(
            `SELECT n.nspname AS name, count(*)::int AS tables FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
            GROUP BY 1 ORDER BY (n.nspname = 'public') DESC, 1`
        )
    ).rows as { name: string; tables: number }[];

    const schema = schemas.find((s) => s.name === requested)?.name || schemas[0]?.name || "public";

    const [tableRows, columnRows, indexRows, relationRows] = await Promise.all([
        pool.query(
            `SELECT c.oid, c.relname AS name, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname LIMIT ${MAX_TABLES + 1}`,
            [schema]
        ),
        pool.query(
            `SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
            FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`,
            [schema]
        ),
        pool.query(
            `SELECT c.relname AS table, i.indisprimary AS primary,
                array(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS columns
            FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND i.indisunique`,
            [schema]
        ),
        pool.query(
            `SELECT con.conname AS name, c.relname AS table, fc.relname AS ref_table,
                array(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS columns,
                array(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS ref_columns
            FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
            WHERE con.contype = 'f' AND n.nspname = $1 AND fn.nspname = $1`,
            [schema]
        ),
    ]);

    const truncated = tableRows.rows.length > MAX_TABLES;
    const tables: DiagramTable[] = tableRows.rows.slice(0, MAX_TABLES).map((row) => ({
        name: row.name,
        estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
        columns: columnRows.rows.filter((column) => column.table === row.name).map((column) => ({ name: column.name, type: column.type, notNull: column.not_null })),
        primaryKey: indexRows.rows.find((index) => index.table === row.name && index.primary)?.columns || [],
        unique: indexRows.rows.filter((index) => index.table === row.name).map((index) => index.columns),
    }));
    const names = new Set(tables.map((table) => table.name));
    const relations: DiagramRelation[] = relationRows.rows
        .filter((row) => names.has(row.table) && names.has(row.ref_table))
        .map((row) => ({ name: row.name, table: row.table, columns: row.columns, refTable: row.ref_table, refColumns: row.ref_columns }));

    return { schema, schemas, tables, relations, truncated };
}
