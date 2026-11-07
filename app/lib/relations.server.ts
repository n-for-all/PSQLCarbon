import type { Pool } from "pg";
import type { DiagramSchema, DiagramTable, InferredRelation } from "./schema-diagram";

/**
 * Many databases don't declare foreign keys. These guess relations from column names (customerId,
 * customer_id, id_customer -> customers) or ask the AI, and check every guess against the data.
 */

const MAX_CANDIDATES = 200;
const SAMPLE_SIZE = 500;
const VERIFY_TIMEOUT_MS = 4000;

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

// Singular and plural spellings a table could have for a referenced name
const nameVariants = (base: string) => {
	const variants = new Set([base, `${base}s`, `${base}es`]);
	if (base.endsWith("y")) variants.add(`${base.slice(0, -1)}ies`);
	if (base.endsWith("s")) variants.add(base.slice(0, -1));
	if (base.endsWith("ies")) variants.add(`${base.slice(0, -3)}y`);
	if (base.endsWith("es")) variants.add(base.slice(0, -2));
	return variants;
};

// Types that can be joined to each other
const typeFamily = (type: string) => {
	const t = type.toLowerCase();
	if (/^(smallint|integer|bigint|numeric|decimal|int|serial)/.test(t)) return "number";
	if (/^(text|character varying|varchar|character|char|citext|name)/.test(t)) return "text";
	return t;
};

/**
 * The column a foreign key column name points at, e.g. customerId -> "customer"
 */
const referencedName = (column: string) => {
	const patterns = [/^(.+?)_?id$/i, /^id_?(.+)$/i, /^(.+?)_?(uuid|key|code|fk)$/i, /^fk_?(.+?)(_?id)?$/i];
	for (const pattern of patterns) {
		const match = pattern.exec(column);
		if (match && match[1] && normalize(match[1]).length > 1) return normalize(match[1]);
	}
	return null;
};

export function inferByName(schema: DiagramSchema): InferredRelation[] {
	const declared = new Set(schema.relations.map((r) => `${r.table}.${r.columns.join(",")}`));
	const byVariant = new Map<string, DiagramTable[]>();
	for (const table of schema.tables) {
		// Prefixes like tbl_ or app_ are common in table names
		for (const name of [normalize(table.name), normalize(table.name.replace(/^(tbl|tb|t|app)_/i, ""))]) {
			if (!byVariant.has(name)) byVariant.set(name, []);
			if (!byVariant.get(name)!.includes(table)) byVariant.get(name)!.push(table);
		}
	}

	const candidates: InferredRelation[] = [];
	for (const table of schema.tables) {
		for (const column of table.columns) {
			// A table's own single column key isn't a reference
			if (table.primaryKey.length === 1 && table.primaryKey[0] === column.name) continue;
			if (declared.has(`${table.name}.${column.name}`)) continue;
			const base = referencedName(column.name);
			if (!base) continue;

			const parents = new Set<DiagramTable>();
			for (const variant of nameVariants(base)) for (const parent of byVariant.get(variant) || []) parents.add(parent);
			// parent_id, manager_id ... point at the same table
			if (["parent", "manager", "supervisor", "referrer", "owner"].includes(base) && table.primaryKey.length === 1) parents.add(table);

			for (const parent of parents) {
				if (parent === table && !["parent", "manager", "supervisor", "referrer", "owner"].includes(base)) continue;
				// The parent's key, or a column with the same name in the parent (orders.customer_code -> customers.customer_code)
				const refColumn =
					parent.primaryKey.length === 1 ? parent.primaryKey[0] : parent.columns.find((c) => c.name === column.name && parent !== table)?.name;
				if (!refColumn) continue;
				const refType = parent.columns.find((c) => c.name === refColumn)?.type || "";
				if (typeFamily(refType) !== typeFamily(column.type)) continue;
				candidates.push({
					name: `inferred_${table.name}_${column.name}`,
					table: table.name,
					columns: [column.name],
					refTable: parent.name,
					refColumns: [refColumn],
					source: "name",
					reason: `${column.name} looks like it refers to ${parent.name}.${refColumn}`,
					sampled: null,
					matched: null,
					confidence: "unverified",
				});
			}
		}
	}
	return candidates.slice(0, MAX_CANDIDATES);
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Samples distinct values of the child column and counts how many exist in the parent
 */
async function verify(pool: Pool, schema: string, relation: InferredRelation, tables: Map<string, DiagramTable>): Promise<InferredRelation> {
	const child = tables.get(relation.table);
	const parent = tables.get(relation.refTable);
	const childType = child?.columns.find((c) => c.name === relation.columns[0])?.type;
	const parentType = parent?.columns.find((c) => c.name === relation.refColumns[0])?.type;
	if (!childType || !parentType) return relation;
	// Same types join on their index, others are compared as text
	const cast = childType === parentType ? "" : "::text";
	const childColumn = ident(relation.columns[0]);
	const parentColumn = ident(relation.refColumns[0]);
	const sql = `SELECT count(*)::int AS sampled, count(p.found)::int AS matched
		FROM (SELECT DISTINCT ${childColumn}${cast} AS v FROM ${ident(schema)}.${ident(relation.table)} WHERE ${childColumn} IS NOT NULL LIMIT ${SAMPLE_SIZE}) s
		LEFT JOIN LATERAL (SELECT 1 AS found FROM ${ident(schema)}.${ident(relation.refTable)} p WHERE p.${parentColumn}${cast} = s.v LIMIT 1) p ON true`;

	const client = await pool.connect();
	try {
		await client.query("BEGIN READ ONLY");
		await client.query(`SET LOCAL statement_timeout = ${VERIFY_TIMEOUT_MS}`);
		const { sampled, matched } = (await client.query(sql)).rows[0];
		await client.query("ROLLBACK");
		const ratio = sampled ? matched / sampled : 0;
		const confidence = !sampled ? "unverified" : ratio >= 0.95 ? "high" : ratio >= 0.7 ? "medium" : "low";
		return { ...relation, sampled, matched, confidence };
	} catch {
		await client.query("ROLLBACK").catch(() => undefined);
		return relation;
	} finally {
		client.release();
	}
}

export async function verifyRelations(pool: Pool, schema: DiagramSchema, relations: InferredRelation[]) {
	const tables = new Map(schema.tables.map((table) => [table.name, table]));
	const results: InferredRelation[] = [];
	// A few at a time, each one is a small query
	for (let i = 0; i < relations.length; i += 4) {
		results.push(...(await Promise.all(relations.slice(i, i + 4).map((relation) => verify(pool, schema.schema, relation, tables)))));
	}
	// Mostly missing values means the guess was wrong, AI suggestions are kept unless nothing matches at all
	return results.filter((relation) => relation.confidence !== "low" || (relation.source === "ai" && (relation.matched || 0) > 0));
}

/**
 * Asks the configured model for relations, it only gets the table and column definitions, never rows
 */
export async function inferWithAi(schema: DiagramSchema, known: InferredRelation[], api: { baseUrl: string; apiKey: string; model: string }) {
	const tables = schema.tables
		.map((table) => `${table.name}(${table.columns.map((c) => `${c.name} ${c.type}${table.primaryKey.includes(c.name) ? " PK" : ""}`).join(", ")})`)
		.join("\n");
	const existing = [...schema.relations, ...known].map((r) => `${r.table}.${r.columns.join(",")} -> ${r.refTable}.${r.refColumns.join(",")}`).join("\n");

	const response = await fetch(`${api.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(api.apiKey ? { Authorization: `Bearer ${api.apiKey}` } : {}) },
		body: JSON.stringify({
			model: api.model,
			temperature: 0,
			messages: [
				{
					role: "system",
					content:
						'You find relationships between tables of a PostgreSQL schema that has no or few declared foreign keys. Reply with JSON only: an array of {"table","column","refTable","refColumn","reason"}. Only include relations you are fairly confident about, where column refers to refColumn (usually a primary key). Use the exact table and column names given.',
				},
				{ role: "user", content: `Tables:\n${tables}\n\nAlready known relations (don't repeat them):\n${existing || "(none)"}` },
			],
		}),
	});
	if (!response.ok) {
		const text = await response.text();
		let detail = text;
		try {
			detail = JSON.parse(text).error?.message || text;
		} catch {
			// not JSON
		}
		throw new Error(`AI API Error: ${detail}`);
	}
	const content: string = ((await response.json()).choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "");
	const json = /\[[\s\S]*\]/.exec(content)?.[0];
	if (!json) return [];

	const byName = new Map(schema.tables.map((table) => [table.name, table]));
	const seen = new Set([...schema.relations, ...known].map((r) => `${r.table}.${r.columns[0]}`));
	const suggestions: InferredRelation[] = [];
	for (const item of JSON.parse(json) as any[]) {
		const child = byName.get(item?.table);
		const parent = byName.get(item?.refTable);
		// Only names that really exist, the model can make things up
		if (!child || !parent || !child.columns.some((c) => c.name === item.column) || !parent.columns.some((c) => c.name === item.refColumn)) continue;
		if (seen.has(`${child.name}.${item.column}`)) continue;
		seen.add(`${child.name}.${item.column}`);
		suggestions.push({
			name: `ai_${child.name}_${item.column}`,
			table: child.name,
			columns: [item.column],
			refTable: parent.name,
			refColumns: [item.refColumn],
			source: "ai",
			reason: String(item.reason || "Suggested by AI").slice(0, 300),
			sampled: null,
			matched: null,
			confidence: "unverified",
		});
	}
	return suggestions.slice(0, MAX_CANDIDATES);
}
