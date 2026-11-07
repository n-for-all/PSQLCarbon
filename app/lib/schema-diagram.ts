// Shared between the diagram page and the server code that loads and infers relations

export interface DiagramColumn {
    name: string;
    type: string;
    notNull: boolean;
}

export interface DiagramTable {
    name: string;
    columns: DiagramColumn[];
    primaryKey: string[];
    /** Column sets with a unique index, a foreign key on one of them is 1:1 */
    unique: string[][];
    estimatedRows: number | null;
}

export interface DiagramRelation {
    name: string;
    table: string;
    columns: string[];
    refTable: string;
    refColumns: string[];
}

export interface DiagramSchema {
    schema: string;
    schemas: { name: string; tables: number }[];
    tables: DiagramTable[];
    relations: DiagramRelation[];
    truncated: boolean;
}

/** A relation that isn't declared as a foreign key, guessed from column names or suggested by AI */
export interface InferredRelation extends DiagramRelation {
    source: "name" | "ai";
    reason: string;
    /** Sampled distinct child values and how many of them exist in the parent */
    sampled: number | null;
    matched: number | null;
    confidence: "high" | "medium" | "low" | "unverified";
}

export const MAX_TABLES = 250;
export const MAX_COLUMNS = 30;
