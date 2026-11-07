import { ArrowRightIcon, ListUnorderedIcon, ServerIcon, TrashIcon, SyncIcon } from "@primer/octicons-react";
import { ActionFunction, LoaderFunction, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useParams } from "@remix-run/react";
import { useState, SyntheticEvent, useEffect, useRef } from "react";
import config from "~/config";
import { Collection } from "~/lib/data/collection";
import db, { ConnectionData } from "~/lib/db";
import { numberWithCommas } from "~/utils/functions";

import Title from "~/components/title";
import { JsonTreeEditor } from "~/components/tree";
import type { Pool } from "pg";
import { CsvTable } from "~/components/csv_table";
import { QueryLibrary } from "~/components/query-library";
import { ExportButtons } from "~/components/export-buttons";
import Modal from "~/ui/modal";
import { Editor } from "@monaco-editor/react";
import { SQL_EDITOR_OPTIONS, useMonacoTheme } from "~/utils/editor";
import { AlertMessage } from "~/components/alert";

import { getSessionConnection } from "~/utils/session.server";
import { runAndRecord } from "~/lib/queries.server";
import { MAX_RESULT_ROWS, runUserQuery } from "~/lib/run-query.server";
import { CollectionDeleteModal } from "~/components/collection";
import { Button } from "~/ui/button";
import { Accordion, AccordionItem, AccordionContent, AccordionTrigger } from "~/ui/accordion";
import { Table, TableBody, TableCell, TableRow } from "~/ui/table";
import { Pagination } from "~/ui/pagination";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "~/ui/select";
import { Alert, AlertTitle, AlertDescription } from "~/ui/alert";
import { SearchInput } from "~/ui/input";

import { toast } from "~/ui/hooks/use-toast";
import { ChartNoAxesColumn, Network } from "lucide-react";

type loaderCollectionData = {
    title: string;
    stats:
        | {
              count: number;
              size: number;
              storageSize: number;
              totalIndexSize: number;
              ns: string;
              host: string;
              localTime: string;
              latencyStats: {
                  reads: {
                      latency: string;
                  };
                  writes: {
                      latency: string;
                  };
                  commands: {
                      latency: string;
                  };
                  transactions: {
                      latency: string;
                  };
                  storageStats: {
                      latency: string;
                  };
              };
              storageStats: {
                  storageSize: number;
                  totalIndexSize: number;
                  totalSize: number;
                  count: number;
              };
              queryExecStats: {
                  collectionScans: {
                      total: number;
                      nonTailable: number;
                  };
              };
          }
        | null
        | any;
    count: number;
    // An unfiltered big table's count comes from the planner's statistics (lib/data/collection.ts)
    countIsEstimate?: boolean;
    documents: string;
    // Results of a query from the editor, at most MAX_RESULT_ROWS rows
    raw?: { columns: string[]; rows: any[]; truncated?: boolean; command?: string; rowCount?: number | null } | null;
    params: { db: string; col: string };
    columns?: any;
    skip?: number;
    limit?: number;
    sort?: { [key: string]: string | number };
    indexes?: Array<{name: string, definition: string}>;
    structure?: Array<{name: string, type: string, max_length: number, is_nullable: string, default_value: string}>;
};



export const IdeWithAutocomplete = ({ onChange, value }) => {
    const monacoTheme = useMonacoTheme();
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    if (!mounted) {
        return <div className="min-h-[150px] border border-neutral-200 p-4 text-xs text-neutral-500">Loading editor...</div>;
    }

    return (
        <Editor
            height="150px"
            language="pgsql"
            theme={monacoTheme}
            value={value}
            onChange={onChange}
            options={SQL_EDITOR_OPTIONS}
        />
    );
};

const loadConnection = async (request: Request): Promise<ConnectionData> => {
    const connection = await getSessionConnection(request);
    if (!connection) {
        throw redirect("/connections");
    }

    return await db(connection);
};

const loadCollectionData = async ({ jsonQuery, request, params, withColumns = false }): Promise<loaderCollectionData> => {
    const url = new URL(request.url);
    const query = url.searchParams;
    if (!params.db) {
        throw new Error("No database specified");
    }
    if (!params.col) {
        throw new Error("No collection specified");
    }

    let sortKey = query.get("sort") || jsonQuery.sort || "";
    const pagination = {
        limit: query.get("limit") || jsonQuery.limit || 10,
        skip: query.get("skip") || jsonQuery.skip || 0,
    };

    if (sortKey != "") {
        pagination["sort"] = {};
        pagination["sort"][sortKey] = query.get("direction") || jsonQuery.direction || 0;
    }

    const mongo = await loadConnection(request);
    const collection = new Collection(mongo, params.db, params.col, config);
    const collectionData = await collection.viewCollection({ ...jsonQuery, ...pagination });
    if (withColumns) {
        let columns: any = {};
        let parsedColumns = await collection.getColumns();
        parsedColumns.forEach((col) => {
            columns[col] = "";
        });
        return { ...collectionData, documents: JSON.stringify(collectionData.docs), params, ...pagination, columns };
    }
    return { ...collectionData, documents: JSON.stringify(collectionData.docs), params, ...pagination };
};

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Primary key columns and column types of a table, rows are only changed through their primary key
 */
async function tableKeys(pool: Pool, table: string, action: "edited" | "deleted") {
    const [primaryKey, columns] = await Promise.all([
        pool.query(
            `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = to_regclass(quote_ident($1)) AND i.indisprimary`,
            [table]
        ),
        pool.query(
            `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
            WHERE a.attrelid = to_regclass(quote_ident($1)) AND a.attnum > 0 AND NOT a.attisdropped`,
            [table]
        ),
    ]);
    const keyColumns: string[] = primaryKey.rows.map((row) => row.name);
    if (keyColumns.length === 0) {
        throw new Error(`This table has no primary key, so a single row can't be ${action} safely. Use the query editor instead.`);
    }
    return { keyColumns, types: new Map<string, string>(columns.rows.map((row) => [row.name, row.type])) };
}

/**
 * Runs a statement that must affect exactly one row, otherwise nothing is changed
 */
async function changeOneRow(pool: Pool, sql: string, values: unknown[]) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(sql, values);
        if (result.rowCount !== 1) {
            await client.query("ROLLBACK");
            throw new Error(result.rowCount === 0 ? "The row was not found, it may have been changed or deleted, reload and try again" : "More than one row matched, nothing was changed");
        }
        await client.query("COMMIT");
        return result.rows[0];
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

const keyValues = (original: Record<string, unknown>, keyColumns: string[]) => {
    if (!original || typeof original !== "object") throw new Error("No row given");
    for (const key of keyColumns) {
        if (original[key] === undefined || original[key] === null) throw new Error(`The row has no value for the primary key "${key}"`);
    }
    return keyColumns.map((column) => original[column]);
};

async function deleteRow(pool: Pool, table: string, original: Record<string, unknown>) {
    const { keyColumns } = await tableKeys(pool, table, "deleted");
    const values = keyValues(original, keyColumns);
    return changeOneRow(pool, `DELETE FROM ${quoteIdent(table)} WHERE ${keyColumns.map((column, i) => `${quoteIdent(column)} = $${i + 1}`).join(" AND ")} RETURNING *`, values);
}

/**
 * Updates one row, found by its primary key values in `original`. Tables without a primary key can't be edited
 * because there is no reliable way to target a single row.
 */
async function updateRow(pool: Pool, table: string, original: Record<string, unknown>, changes: Record<string, unknown>) {
    if (!original || !changes || typeof changes !== "object" || Object.keys(changes).length === 0) {
        throw new Error("Nothing to save");
    }

    const { keyColumns, types } = await tableKeys(pool, table, "edited");
    for (const key of Object.keys(changes)) {
        if (!types.has(key)) throw new Error(`Unknown column "${key}"`);
    }
    const keys = keyValues(original, keyColumns);

    // json/jsonb take JSON text, other objects are sent as JSON text too and Postgres casts them
    const toParam = (column: string, value: unknown) => {
        if (value === null || value === undefined) return null;
        const type = types.get(column) || "";
        if (type === "json" || type === "jsonb") return JSON.stringify(value);
        if (typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
        return value;
    };

    const changed = Object.keys(changes);
    const values = [...changed.map((column) => toParam(column, changes[column])), ...keys];
    const sql = `UPDATE ${quoteIdent(table)} SET ${changed.map((column, i) => `${quoteIdent(column)} = $${i + 1}`).join(", ")}
        WHERE ${keyColumns.map((column, i) => `${quoteIdent(column)} = $${changed.length + i + 1}`).join(" AND ")} RETURNING *`;

    return changeOneRow(pool, sql, values);
}

export const action: ActionFunction = async ({ request, params }) => {
    try {
        const jsonQuery = await request.json();
        if (!jsonQuery) {
            return Response.json({ status: "error", message: "No query specified" }, { status: 500 });
        }

        if (jsonQuery.sql) {
            const mongo = await loadConnection(request);
            const pool = mongo.getPool(params.db);
            if (!pool) {
                return Response.json({ status: "error", message: "No database connection" }, { status: 500 });
            }

            try {
                const connection = await getSessionConnection(request);
                const run = () => runUserQuery(pool, jsonQuery.sql);
                const res = connection ? await runAndRecord({ userId: connection.userId, connectionId: connection.id, database: params.db!, sql: jsonQuery.sql }, run) : await run();
                // Columns and rows for the results view, at most MAX_RESULT_ROWS rows
                const raw = {
                    columns: res.fields.map((f) => f.name),
                    rows: res.rows,
                    truncated: res.truncated,
                    command: res.command,
                    rowCount: res.rowCount,
                };
                return Response.json({ status: "success", raw }, { status: 200 });
            } catch (e: any) {
                return Response.json({ status: "error", message: e.message }, { status: 500 });
            }
        }

        if (jsonQuery.deleteRow) {
            const mongo = await loadConnection(request);
            const pool = mongo.getPool(params.db);
            if (!pool) {
                return Response.json({ status: "error", message: "No database connection" }, { status: 500 });
            }
            try {
                const row = await deleteRow(pool, params.col!, jsonQuery.deleteRow.original);
                return Response.json({ status: "success", row });
            } catch (e: any) {
                return Response.json({ status: "error", message: e.message }, { status: 400 });
            }
        }

        if (jsonQuery.updateRow) {
            const mongo = await loadConnection(request);
            const pool = mongo.getPool(params.db);
            if (!pool) {
                return Response.json({ status: "error", message: "No database connection" }, { status: 500 });
            }
            try {
                const row = await updateRow(pool, params.col!, jsonQuery.updateRow.original, jsonQuery.updateRow.changes);
                return Response.json({ status: "success", row });
            } catch (e: any) {
                return Response.json({ status: "error", message: e.message }, { status: 400 });
            }
        }

        // Standard pagination/sorting
        const output = await loadCollectionData({
            jsonQuery,
            request,
            params,
            withColumns: false,
        });

        return Response.json({ status: "success", raw: null, ...output }, { status: 200 });
    } catch (e: any) {
        return Response.json({ status: "error", message: e.message }, { status: 500 });
    }
};
export const loader: LoaderFunction = async ({ request, params }) => {
    try {
        const data = await loadCollectionData({ jsonQuery: {}, request, params, withColumns: true });
        return Response.json(
            { ...data },
            {
                headers: {
                    "Cache-Control": "no-store",
                },
            }
        );
    } catch (e: any) {
        if (e instanceof Response) {
            return e;
        }
        return Response.json({ status: "error", message: e.message }, { status: 500 });
    }
};

const RecordCard = ({
    doc,
    columns,
    startEditing = false,
    onDelete,
}: {
    doc: Record<string, unknown>;
    columns: Record<string, any>;
    /** Opens in edit mode, used by the edit button of the table view */
    startEditing?: boolean;
    onDelete: (row: Record<string, unknown>) => void;
}) => {
    const fetcher = useFetcher<{ status: string; message?: string; row?: Record<string, unknown> }>();
    const [saved, setSaved] = useState(doc);
    const [draft, setDraft] = useState<Record<string, unknown> | null>(() => (startEditing ? structuredClone(doc) : null));
    const cardRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (startEditing) cardRef.current?.scrollIntoView({ block: "center" });
    }, [startEditing]);
    // Stay open after saving so the saved values are visible
    const [justSaved, setJustSaved] = useState(false);

    useEffect(() => setSaved(doc), [doc]);

    useEffect(() => {
        if (fetcher.state !== "idle" || !fetcher.data) return;
        if (fetcher.data.status === "success" && fetcher.data.row) {
            setSaved(fetcher.data.row);
            setDraft(null);
            setJustSaved(true);
            toast({ title: "Row saved", type: "background" });
        } else if (fetcher.data.status === "error") {
            toast({ variant: "error", title: "Could not save", description: fetcher.data.message });
        }
    }, [fetcher.state, fetcher.data]);

    // Only fields the user changed are sent, compared by value. A deleted field means NULL, a row always has every column
    const changes = draft
        ? Object.fromEntries(
              [...new Set([...Object.keys(saved), ...Object.keys(draft)])]
                  .map((key) => [key, key in draft ? draft[key] : null] as const)
                  .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(saved[key] ?? null))
          )
        : {};
    const changedCount = Object.keys(changes).length;
    const saving = fetcher.state !== "idle";

    return (
        <div ref={cardRef} className={`w-full p-4 mb-3 overflow-auto bg-white border border-solid ${draft ? "border-primary" : "border-neutral-300"}`}>
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    {/* Remounted when editing starts so the record opens expanded */}
                    <JsonTreeEditor key={draft ? "edit" : justSaved ? "saved" : "view"} autocompleteItems={columns} isExpanded={!!draft || justSaved} data={draft || saved} onChange={draft ? (data) => setDraft({ ...(data as Record<string, unknown>) }) : undefined} />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {draft ? (
                        <>
                            {changedCount > 0 && <span className="text-xs text-neutral-500">{changedCount} changed</span>}
                            <Button
                                size="xs"
                                disabled={changedCount === 0 || saving}
                                loading={saving}
                                onClick={() => fetcher.submit({ updateRow: { original: saved, changes } } as any, { method: "POST", encType: "application/json" })}>
                                Save
                            </Button>
                            <Button size="xs" variant="outline" disabled={saving} onClick={() => setDraft(null)}>
                                Cancel
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button size="xs" variant="outline" onClick={() => setDraft(structuredClone(saved))}>
                                Edit
                            </Button>
                            <Button size="xs" variant="outline" className="text-red-600" icon={<TrashIcon />} onClick={() => onDelete(saved)}>
                                Delete
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

const DeleteRowModal = ({ row, onClose, onDeleted }: { row: Record<string, unknown> | null; onClose: () => void; onDeleted: () => void }) => {
    const fetcher = useFetcher<{ status: string; message?: string }>();

    useEffect(() => {
        if (fetcher.state !== "idle" || !fetcher.data) return;
        if (fetcher.data.status === "success") {
            toast({ title: "Row deleted", type: "background" });
            onDeleted();
            onClose();
        } else {
            toast({ variant: "error", title: "Could not delete", description: fetcher.data.message });
        }
    }, [fetcher.state, fetcher.data]);

    // A few fields so the user can tell which row this is
    const preview = row ? Object.entries(row).slice(0, 4) : [];

    return (
        <Modal
            open={!!row}
            danger={true}
            loading={fetcher.state !== "idle"}
            loadingDescription="Deleting..."
            modalHeading="Delete row"
            modalLabel="This can't be undone"
            primaryButtonText="Delete"
            secondaryButtonText="Cancel"
            onClose={onClose}
            onSecondaryClick={onClose}
            onPrimaryClick={() => fetcher.submit({ deleteRow: { original: row } } as any, { method: "POST", encType: "application/json" })}>
            <p className="mb-3 text-sm">Are you sure you want to permanently delete this row?</p>
            <div className="p-3 font-mono text-xs border bg-neutral-50 border-neutral-200">
                {preview.map(([key, value]) => (
                    <div key={key} className="truncate">
                        <span className="font-semibold">{key}:</span> {typeof value === "object" ? JSON.stringify(value) : String(value)}
                    </div>
                ))}
            </div>
        </Modal>
    );
};

export default function CollectionPage() {
    const loaderData = useLoaderData<typeof loader>();
    const [currentPage, setCurrentPage] = useState({
        page: 1,
        pageSize: 10,
    });
    // Query results are paged in the browser, they're already all here
    const [resultsPage, setResultsPage] = useState({ page: 1, pageSize: 50 });
    const [sort, setSort] = useState({
        field: "",
        direction: 0,
    });

    const fetcher = useFetcher<
        {
            status: string;
            message?: string;
        } & loaderCollectionData
    >();

    const pageFetcher = useFetcher<
        {
            status: string;
            message?: string;
        } & loaderCollectionData
    >();

    const initRef = useRef(false);
    // What the user asked for last, a table page or a query. A slower answer to the other one is dropped, so a
    // page that loads after a query doesn't replace its results (or the other way round).
    const lastRequest = useRef<"page" | "query">("page");

    const [view, setView] = useState("grid");
    // Row opened for editing from the table view, and the row waiting for delete confirmation
    const [editIndex, setEditIndex] = useState<number | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<Record<string, unknown> | null>(null);
    useEffect(() => {
        if (view === "grid") setEditIndex(null);
    }, [view]);
    const [jsonQuery, setJsonQuery] = useState({});
    const [jsonQueryString, setJsonQueryString] = useState("");
    const [errorJsonQueryString, setErrorJsonQueryString] = useState("");
    const [isDelete, setIsDelete] = useState(false);
    const [searchField, setSearchField] = useState("");
    const [searchValue, setSearchValue] = useState("");
    const navigate = useNavigate();

    const { columns } = loaderData;
    const [data, setData] = useState<loaderCollectionData>(loaderData);
    const { title, stats, count, countIsEstimate, documents: loaderDocuments, raw, indexes, structure } = data;
    const routeParams = useParams();

    let documents = [];
    try {
        if (loaderDocuments && loaderDocuments !== "undefined") {
            documents = JSON.parse(loaderDocuments);
        }
    } catch (e) {}
    const loading = fetcher.state == "submitting" || fetcher.state == "loading";

    useEffect(() => {
        const handler = (e: any) => {
            const sql = e.detail?.sql;
            if (sql) {
                setJsonQueryString(sql);
                setErrorJsonQueryString("");
            }
        };
        window.addEventListener("ai-populate-editor", handler);
        return () => window.removeEventListener("ai-populate-editor", handler);
    }, []);

    // The query behind the shown results, exports run it again
    const [ranSql, setRanSql] = useState("");
    const executeSql = () => {
        if (!jsonQueryString || jsonQueryString.trim() === "") {
            setErrorJsonQueryString("Please enter a SQL query");
            return;
        }

        setErrorJsonQueryString("");
        setRanSql(jsonQueryString);
        lastRequest.current = "query";
        fetcher.submit(
            {
                sql: jsonQueryString,
            },
            {
                method: "POST",
                encType: "application/json",
                action: `/database/${routeParams.db}/${routeParams.col}`,
            }
        );
    };

    const refreshData = (pageOverride?: number) => {
        const pageToUse = pageOverride || currentPage.page;
        const paginationObj: any = {};
        if (pageToUse > 1) {
            const skip = (pageToUse - 1) * currentPage.pageSize;
            paginationObj["skip"] = skip;
        }

        if (currentPage.pageSize != 10) {
            paginationObj["limit"] = currentPage.pageSize;
        }

        const payload: any = {
            ...paginationObj,
            sort: sort.field,
            direction: sort.direction,
        };

        if (searchField && searchValue) {
            payload.key = searchField;
            payload.value = searchValue;
            payload.type = "S";
        }

        lastRequest.current = "page";
        pageFetcher.submit(
            payload,
            {
                method: "POST",
                encType: "application/json",
                action: `/database/${routeParams.db}/${routeParams.col}`,
            }
        );
    };

    useEffect(() => {
        if (!initRef.current) {
            initRef.current = true;
            return; // Skip effect on first render
        }

        if (!routeParams.db || !routeParams.col) {
            return;
        }

        refreshData();
    }, [currentPage.page, currentPage.pageSize, sort.field, sort.direction]);

    useEffect(() => {
        if (fetcher.data && fetcher.data.status == "success") {
            if (lastRequest.current !== "query") return;
            const result = fetcher.data;
            setData((current) => ({ ...current, ...result }));
            // Only the results start over, changing the table's page here would load its rows over the results
            setResultsPage((current) => ({ ...current, page: 1 }));

            toast({
                title: "Success",
                variant: "success",
                description: "Executed",
            });
        } else if (fetcher.data && fetcher.data.status == "error") {
            setErrorJsonQueryString(fetcher.data?.message || "");
        }
    }, [fetcher.data]);

    useEffect(() => {
        if (pageFetcher.data && pageFetcher.data.status == "success") {
            if (lastRequest.current !== "page") return;
            const result = pageFetcher.data;
            setData((current) => ({ ...current, ...result }));
            setCurrentPage({
                ...currentPage,
                page: pageFetcher.data.skip ? Math.floor((pageFetcher.data.skip || 0) / (pageFetcher.data.limit || 10)) + 1 : 1,
                pageSize: pageFetcher.data.limit || 10,
            });
        } else if (pageFetcher.data && pageFetcher.data.status == "error") {
            setErrorJsonQueryString(pageFetcher.data?.message || "");
        }
    }, [pageFetcher.data]);



    const errorData = data as any;
    if (errorData?.status === "error" || errorData?.error) {
        return (
            <div className="p-4 bg-white border border-neutral-200 m-4 flex flex-col gap-4 items-start">
                <Alert variant="error">
                    <AlertTitle>Table Error</AlertTitle>
                    <AlertDescription>{errorData.message || errorData.error || "The table could not be found or has been deleted."}</AlertDescription>
                </Alert>
                <Button onClick={() => navigate(`/database/${routeParams.db}`)}>Go Back to Database</Button>
            </div>
        );
    }

    if (!stats) {
        return <div>Loading...</div>;
    }

    const isRaw = !!raw;
    const resultsStart = (resultsPage.page - 1) * resultsPage.pageSize;
    const currentRows = isRaw ? raw.rows.slice(resultsStart, resultsStart + resultsPage.pageSize) : documents;
    const currentColumns = isRaw ? raw.columns : (Array.isArray(data.columns) ? data.columns : Object.keys(data.columns || {}));

    let items: any = null;
    if (isRaw && raw.rows.length === 0) {
        // Nothing to list, say what the statement did instead of showing bare column headers
        const changed = raw.command && raw.command !== "SELECT";
        items = (
            <div className="p-6 text-sm text-center border border-dashed text-neutral-600 border-neutral-300">
                {changed ? `${raw.command} changed ${(raw.rowCount ?? 0).toLocaleString()} row${raw.rowCount === 1 ? "" : "s"}` : "The query returned no rows"}
            </div>
        );
    } else if (view == "grid") {
        items = (
            <CsvTable
                sort={sort}
                columns={currentColumns}
                onSort={(key) => {
                    setSort((prevSort) => ({
                        field: key,
                        direction: prevSort.field == key ? prevSort.direction * -1 : 1,
                    }));
                    if (!isRaw) setCurrentPage({ ...currentPage, page: 1 });
                }}
                rows={currentRows || []}
                {...(isRaw
                    ? {}
                    : {
                          onEditRow: (_row: any, index: number) => {
                              setEditIndex(index);
                              setView("list");
                          },
                          onDeleteRow: (row: any) => setDeleteTarget(row),
                      })}
            />
        );
    } else {
        items = currentRows?.map((doc: any, index: number) =>
            isRaw ? (
                <div key={index} className="w-full p-4 mb-3 overflow-auto bg-white border border-solid border-neutral-300">
                    <JsonTreeEditor autocompleteItems={columns} isExpanded={false} data={doc} />
                </div>
            ) : (
                <RecordCard key={`${index}:${JSON.stringify(doc)}`} doc={doc} columns={columns} startEditing={editIndex === index} onDelete={setDeleteTarget} />
            )
        );
    }

    return (
        <>
            <div className="database-page">
                <div className="flex items-center justify-between pb-4">
                    <div>
                        <Title title={title}>
                            <>
                                <span className="font-normal text-base opacity-50">Table:</span>
                                <span className="ml-1 font-mono text-base">{title}</span>
                            </>
                        </Title>
                        <div className="flex flex-wrap items-center gap-3">
                            <p className="text-sm">
                                {isRaw
                                    ? `Returned Rows: ${raw.truncated ? "first " : ""}${raw.rows.length.toLocaleString()}`
                                    : `Total Rows: ${countIsEstimate ? "about " : ""}${(count || 0).toLocaleString()}`}
                            </p>
                            {isRaw && raw.columns?.length > 0 && ranSql && <ExportButtons database={routeParams.db} sql={ranSql} />}
                            {isRaw && (
                                <button type="button" className="text-xs underline text-neutral-500 hover:text-neutral-900" onClick={() => setData({ ...data, raw: null })}>
                                    Show the table's rows
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center justify-end gap-1">
                        <Button
                            size="sm"
                            variant="outline"
                            icon={<Network size={16} />}
                            onClick={() => navigate(`/diagram/${encodeURIComponent(routeParams.db!)}?focus=${encodeURIComponent(title)}`)}>
                            Relations
                        </Button>
                        <Button
                            size="sm"
                            variant="danger"
                            icon={<TrashIcon />}
                            tooltip="Delete Table"
                            onClick={(e: SyntheticEvent) => {
                                e.preventDefault();
                                setIsDelete(true);
                            }}>
                            Delete Table
                        </Button>
                    </div>
                </div>
                <div className="p-4 mt-1 mb-1 border border-solid border-neutral-300">
                    <div className="py-1">
                        <span className="block text-base font-bold">Query</span>
                        <span className="block mb-2 text-xs opacity-50">Please enter your query below</span>
                    </div>
                    <QueryLibrary database={routeParams.db} sql={jsonQueryString || ""} onLoad={(sql) => { setJsonQueryString(sql); setErrorJsonQueryString(""); }} refreshKey={fetcher.data} />
                    <div className="flex flex-col bg-white border border-neutral-200 min-h-36">
                        <div className="flex-1 overflow-auto">
                            <IdeWithAutocomplete
                                value={jsonQueryString}
                                onChange={(data) => {
                                    setJsonQueryString(data);
                                }}
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-2 mt-2">
                        <div className="flex items-center justify-between">
                            <Button
                                size="sm"
                                disabled={!jsonQueryString || jsonQueryString == ""}
                                icon={<ArrowRightIcon />}
                                loading={loading}
                                onClick={(e: SyntheticEvent) => {
                                    e.preventDefault();
                                    executeSql();
                                }}>
                                Execute SQL
                            </Button>
                        </div>
                        {errorJsonQueryString != "" && <AlertMessage message={errorJsonQueryString} onClose={() => setErrorJsonQueryString("")} />}
                    </div>
                </div>

                <div className="mb-3 bg-neutral-100">
                    <Accordion type="multiple">
                        <AccordionItem value="statistics" className="pr-0 ">
                            <AccordionTrigger className="px-4 border-t border-solid border-neutral-200">
                                <span className="flex items-center font-medium">
                                    <ChartNoAxesColumn className="w-4 h-4 mr-2" /> Statistics
                                </span>
                            </AccordionTrigger>

                            <AccordionContent className="px-0">
                                <div className="flex flex-col items-start w-full pb-4 lg:flex-row p-4">
                                    <div className="flex-1 w-full mr-4">
                                        <Table className="text-md">
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell className="font-bold">Namespace (Table)</TableCell>
                                                    <TableCell>{stats.ns}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Local Time</TableCell>
                                                    <TableCell>{stats.localTime}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Storage Size</TableCell>
                                                    <TableCell>{numberWithCommas(stats.storageStats?.storageSize)} B</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Total Index Size</TableCell>
                                                    <TableCell>{numberWithCommas(stats.storageStats?.totalIndexSize)} B</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Total Size</TableCell>
                                                    <TableCell>{numberWithCommas(stats.storageStats?.totalSize)} B</TableCell>
                                                </TableRow>
                                            </TableBody>
                                        </Table>
                                    </div>
                                    <div className="flex-1 w-full">
                                        <Table className="mt-4 text-md lg:mt-0">
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell className="font-bold">Live Tuples (Rows)</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.liveTuples)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Tuples Inserted</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.inserted)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Tuples Updated</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.updated)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Tuples Deleted</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.deleted)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Sequential Scans</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.seqScans)}</TableCell>
                                                </TableRow>
                                                <TableRow>
                                                    <TableCell className="font-bold">Index Scans</TableCell>
                                                    <TableCell>{numberWithCommas(stats.queryExecStats?.idxScans)}</TableCell>
                                                </TableRow>
                                            </TableBody>
                                        </Table>
                                    </div>
                                </div>
                            </AccordionContent>
                        </AccordionItem>
                        {structure && structure.length > 0 && (
                            <AccordionItem value="structure" className="pr-0 ">
                                <AccordionTrigger className="px-4 border-t border-solid border-neutral-200">
                                    <span className="flex items-center font-medium">
                                        <ListUnorderedIcon className="w-4 h-4 mr-2" /> Structure
                                    </span>
                                </AccordionTrigger>
                                <AccordionContent className="px-0">
                                    <div className="p-4 w-full overflow-x-auto">
                                        <Table className="text-md">
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell className="font-bold">Name</TableCell>
                                                    <TableCell className="font-bold">Type</TableCell>
                                                    <TableCell className="font-bold">Max Length</TableCell>
                                                    <TableCell className="font-bold">Nullable</TableCell>
                                                    <TableCell className="font-bold">Default Value</TableCell>
                                                </TableRow>
                                                {structure.map((col, i) => (
                                                    <TableRow key={i}>
                                                        <TableCell>{col.name}</TableCell>
                                                        <TableCell>{col.type}</TableCell>
                                                        <TableCell>{col.max_length || "-"}</TableCell>
                                                        <TableCell>{col.is_nullable}</TableCell>
                                                        <TableCell>{col.default_value || "-"}</TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </div>
                                </AccordionContent>
                            </AccordionItem>
                        )}
                        {indexes && indexes.length > 0 && (
                            <AccordionItem value="indexes" className="pr-0 ">
                                <AccordionTrigger className="px-4 border-t border-solid border-neutral-200">
                                    <span className="flex items-center font-medium">
                                        <ServerIcon className="w-4 h-4 mr-2" /> Indexes
                                    </span>
                                </AccordionTrigger>
                                <AccordionContent className="px-0">
                                    <div className="p-4 w-full overflow-x-auto">
                                        <Table className="text-md">
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell className="font-bold">Name</TableCell>
                                                    <TableCell className="font-bold">Definition</TableCell>
                                                </TableRow>
                                                {indexes.map((idx, i) => (
                                                    <TableRow key={i}>
                                                        <TableCell>{idx.name}</TableCell>
                                                        <TableCell className="font-mono text-xs">{idx.definition}</TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </div>
                                </AccordionContent>
                            </AccordionItem>
                        )}
                    </Accordion>
                </div>
                
                <div className="flex items-center gap-2 mb-3 bg-neutral-100 p-2 border border-neutral-200">
                    <Select value={searchField} onValueChange={setSearchField}>
                        <SelectTrigger className="w-[180px] h-8 bg-white text-xs font-semibold">
                            <SelectValue placeholder="Select Column" />
                        </SelectTrigger>
                        <SelectContent>
                            {currentColumns.map((col: string) => (
                                <SelectItem key={col} value={col}>{col}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <SearchInput
                        placeholder="Search exactly..." 
                        value={searchValue}
                        onChange={(value) => setSearchValue(value)}
                        onKeyDown={(e: React.KeyboardEvent) => {
                            if (e.key === "Enter") {
                                if (currentPage.page === 1) {
                                    refreshData();
                                } else {
                                    setCurrentPage({ ...currentPage, page: 1 });
                                }
                            }
                        }}
                        className="w-[250px] h-8 text-xs border-neutral-300"
                    />
                    <Button size="sm" variant="secondary" onClick={() => {
                        if (currentPage.page === 1) {
                            refreshData();
                        } else {
                            setCurrentPage({ ...currentPage, page: 1 });
                        }
                    }}>
                        Search
                    </Button>
                    {searchField && searchValue && (
                        <Button size="sm" variant="ghost" onClick={() => {
                            setSearchValue("");
                            setSearchField("");
                            setTimeout(() => {
                                if (currentPage.page === 1) {
                                    lastRequest.current = "page";
                                    pageFetcher.submit(
                                        {
                                            sort: sort.field,
                                            direction: sort.direction,
                                            limit: currentPage.pageSize
                                        },
                                        { method: "POST", encType: "application/json", action: `/database/${routeParams.db}/${routeParams.col}` }
                                    );
                                } else {
                                    setCurrentPage({ ...currentPage, page: 1 });
                                }
                            }, 0);
                        }}>
                            Clear
                        </Button>
                    )}
                    <div className="flex items-center gap-1 ml-auto">
                        {/* How the rows below are shown */}
                        <div className="flex items-center bg-white border border-neutral-200">
                            <Button
                                size="sm"
                                variant="ghost"
                                hasIconOnly
                                className={view == "grid" ? "bg-neutral-200" : ""}
                                icon={<ServerIcon />}
                                tooltip="Table view"
                                aria-pressed={view == "grid"}
                                onClick={(e: SyntheticEvent) => {
                                    e.preventDefault();
                                    setView("grid");
                                }}
                            />
                            <Button
                                size="sm"
                                variant="ghost"
                                hasIconOnly
                                className={view == "list" ? "bg-neutral-200" : ""}
                                icon={<ListUnorderedIcon />}
                                tooltip="List view (edit rows)"
                                aria-pressed={view == "list"}
                                onClick={(e: SyntheticEvent) => {
                                    e.preventDefault();
                                    setView("list");
                                }}
                            />
                        </div>
                        <Button size="sm" variant="ghost" icon={<SyncIcon />} hasIconOnly tooltip="Refresh" onClick={() => refreshData()} />
                    </div>
                </div>

                {isRaw && raw.truncated && (
                    <div className="px-3 py-2 mb-3 text-xs border text-amber-800 bg-amber-50 border-amber-200">
                        Showing the first {raw.rows.length.toLocaleString()} rows of the result. Export it to get every row, or narrow it down with WHERE or LIMIT and OFFSET.
                    </div>
                )}
                <div className="w-full min-h-72">{items}</div>
            </div>
            {isRaw ? (
                // Pages through the query results, which are already loaded
                <Pagination
                    key="results"
                    className="mt-3 mb-10 text-sm"
                    backwardText="Previous page"
                    forwardText="Next page"
                    itemsPerPageText="Rows per page:"
                    onChange={({ page, pageSize }) => setResultsPage({ page, pageSize })}
                    page={resultsPage.page}
                    pageSize={resultsPage.pageSize}
                    pageSizes={[10, 20, 30, 40, 50, 100, 500]}
                    size="md"
                    totalItems={raw.rows.length}
                    itemRangeText={(min, max, total) => `${min.toLocaleString()}–${max.toLocaleString()} of ${total.toLocaleString()} ${raw.truncated ? "returned " : ""}rows`}
                    pageRangeText={(_current, total) => `of ${total.toLocaleString()} pages`}
                />
            ) : (
                <Pagination
                    key="table"
                    className="mt-3 mb-10 text-sm"
                    backwardText="Previous page"
                    forwardText="Next page"
                    itemsPerPageText="Items per page:"
                    onChange={({ page, pageSize }) => {
                        setCurrentPage({ page, pageSize });
                    }}
                    page={currentPage.page}
                    pageSize={currentPage.pageSize}
                    pageSizes={[10, 20, 30, 40, 50, 100, 500]}
                    size="md"
                    totalItems={count}
                    itemRangeText={(min, max, total) => `${min.toLocaleString()}–${max.toLocaleString()} of ${countIsEstimate ? "about " : ""}${total.toLocaleString()} rows`}
                    pageRangeText={(_current, total) => `of ${countIsEstimate ? "about " : ""}${total.toLocaleString()} pages`}
                />
            )}
            <DeleteRowModal
                row={deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onDeleted={() => {
                    setEditIndex(null);
                    refreshData();
                }}
            />
            <CollectionDeleteModal
                open={isDelete}
                onClose={() => setIsDelete(false)}
                collectionName={title}
                dbName={routeParams.db as string}
                onSuccess={() => {
                    setIsDelete(false);
                    navigate(`/database/${routeParams.db}`);
                }}
            />

        </>
    );
}
