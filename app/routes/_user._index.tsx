import { LoaderFunction, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import db, { ConnectionData } from "~/lib/db";
import { Table, TableBody, TableCell, TableRow } from "~/ui/table";
import { getSessionConnection } from "~/utils/session.server";
import { Editor } from "@monaco-editor/react";
import { SQL_EDITOR_OPTIONS, useMonacoTheme } from "~/utils/editor";
import { AlertMessage } from "~/components/alert";
import { CsvTable } from "~/components/csv_table";
import { QueryLibrary } from "~/components/query-library";
import { ExportButtons } from "~/components/export-buttons";
import { useState, useEffect, SyntheticEvent } from "react";
import { Button } from "~/ui/button";
import { ArrowRightIcon } from "@primer/octicons-react";
import { Terminal } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/select";

const formatUptime = (seconds: unknown) => {
    const total = Math.floor(Number(seconds));
    if (!isFinite(total) || total < 0) return "N/A";
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return [days && `${days}d`, (days || hours) && `${hours}h`, `${minutes}m`].filter(Boolean).join(" ");
};

export const loader: LoaderFunction = async ({ request }) => {
    const connection = await getSessionConnection(request);
    if (!connection) {
        return redirect("/connections");
    }

    let mongo: ConnectionData;

    try {
        mongo = await db(connection);
    } catch (error) {
        return Response.json({ status: "error", message: "Could not connect to database" }, { status: 500 });
    }

    const pool = mongo.getPool();
    let version = "Unknown";
    let uptime = "N/A";

    if (pool) {
        try {
            // One round trip for both, it adds up on a remote server
            const res = await pool.query("SELECT version() AS version, extract(epoch from (now() - pg_postmaster_start_time())) AS uptime;");
            version = res.rows[0].version;
            uptime = res.rows[0].uptime;
        } catch (e) {
            console.error(e);
        }
    }

    let databases: string[] = [];
    try {
        databases = await mongo.getDatabases();
    } catch (e) {
        console.error("Could not fetch databases", e);
    }

    return Response.json(
        { info: { version, uptime }, versions: process.versions, databases },
        {
            headers: {
                "Cache-Control": "no-store",
            },
        }
    );
};

const IdeWithAutocomplete = ({ onChange, value }: { onChange: (v: string | undefined) => void; value: string }) => {
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

export default function Dashboard() {
    const loaderData = useLoaderData<typeof loader>();
    const info = loaderData?.info;
    const versions = loaderData?.versions;
    const databases = loaderData?.databases || [];

    // ── Query editor state ──────────────────────────────────────────────
    const queryFetcher = useFetcher<any>();
    const [sqlQuery, setSqlQuery] = useState("");
    const [selectedDb, setSelectedDb] = useState<string>(databases.includes("postgres") ? "postgres" : (databases[0] || ""));
    const [queryError, setQueryError] = useState("");
    // At most MAX_RESULT_ROWS rows come back (lib/run-query.server.ts), truncated says there were more
    const [queryResult, setQueryResult] = useState<{ columns: string[]; rows: any[]; truncated?: boolean; command?: string; rowCount?: number | null } | null>(null);
    const queryLoading = queryFetcher.state === "submitting" || queryFetcher.state === "loading";

    useEffect(() => {
        if (!queryFetcher.data) return;
        if (queryFetcher.data.message) {
            setQueryError(queryFetcher.data.message);
            setQueryResult(null);
        } else {
            setQueryError("");
            const { columns, rows, truncated, command, rowCount } = queryFetcher.data;
            setQueryResult({ columns: columns || [], rows: rows || [], truncated, command, rowCount });
        }
    }, [queryFetcher.data]);

    // The query behind the shown results, exports run it again
    const [ranSql, setRanSql] = useState("");
    const executeDbSql = () => {
        if (!sqlQuery || sqlQuery.trim() === "") {
            setQueryError("Please enter a SQL query");
            return;
        }
        if (!selectedDb) {
            setQueryError("Please select a database to run the query against");
            return;
        }
        setQueryError("");
        setQueryResult(null);
        setRanSql(sqlQuery);
        queryFetcher.submit(
            { sql: sqlQuery, db: selectedDb },
            { method: "POST", encType: "application/json", action: "/api/query" }
        );
    };
    // ───────────────────────────────────────────────────────────────────

    return (
        <div>
            <div className="pb-4">
                <h4 className="text-xl font-medium">Server Information</h4>
                <p className="text-sm">Version: {info?.version}</p>
            </div>
            <div className="pb-4">
                <Table className="w-full bg-neutral-100 text-md">
                    <TableBody>
                        <TableRow className="border-b">
                            <TableCell className="px-4 py-2 font-semibold whitespace-nowrap">Uptime</TableCell>
                            <TableCell className="px-4 py-2">{formatUptime(info?.uptime)}</TableCell>
                        </TableRow>
                        <TableRow className="border-b">
                            <TableCell className="px-4 py-2 font-semibold whitespace-nowrap">Node Version</TableCell>
                            <TableCell className="px-4 py-2 break-all">{versions?.node}</TableCell>
                        </TableRow>
                        <TableRow className="border-b">
                            <TableCell className="px-4 py-2 font-semibold whitespace-nowrap">V8 Version</TableCell>
                            <TableCell className="px-4 py-2 break-all">{versions?.v8}</TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
            </div>

            {/* ── Server-level Query Editor ── */}
            <div className="p-4 mt-1 mb-4 border border-solid border-neutral-300">
                <div className="flex flex-wrap items-center justify-between py-1 mb-2 gap-x-4 gap-y-2">
                    <div className="min-w-0">
                        <span className="flex items-center gap-1 text-base font-bold whitespace-nowrap">
                            <Terminal size={15} />
                            Global Query Editor
                        </span>
                        <span className="block text-xs opacity-50">Run SQL queries against any database on this server</span>
                    </div>
                    {databases.length > 0 && (
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium shrink-0">Database:</span>
                            <Select value={selectedDb} onValueChange={(val) => setSelectedDb(val)}>
                                <SelectTrigger className="w-[200px] max-w-full h-8 bg-white">
                                    <SelectValue placeholder="Select Database" />
                                </SelectTrigger>
                                <SelectContent className="bg-white">
                                    {databases.map((dbName: string) => {
                                        const isSystemDb = ["postgres", "template0", "template1"].includes(dbName);
                                        return (
                                            <SelectItem key={dbName} value={dbName}>
                                                <div className="flex items-center gap-2">
                                                    <span>{dbName}</span>
                                                    {isSystemDb && (
                                                        <span className="px-1.5 py-0.5 text-[10px] font-medium leading-none text-neutral-500 bg-neutral-100 rounded border border-neutral-200">
                                                            System DB
                                                        </span>
                                                    )}
                                                </div>
                                            </SelectItem>
                                        );
                                    })}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                </div>
                
                <QueryLibrary database={selectedDb} sql={sqlQuery} onLoad={setSqlQuery} refreshKey={queryFetcher.data} />
                <div className="flex flex-col bg-white border border-neutral-200 min-h-36">
                    <div className="flex-1 overflow-auto">
                        <IdeWithAutocomplete
                            value={sqlQuery}
                            onChange={(val) => setSqlQuery(val ?? "")}
                        />
                    </div>
                </div>
                <div className="flex flex-col gap-2 mt-2">
                    <div className="flex items-center justify-between">
                        <Button
                            size="sm"
                            disabled={!sqlQuery || sqlQuery === ""}
                            icon={<ArrowRightIcon />}
                            loading={queryLoading}
                            onClick={(e: SyntheticEvent) => {
                                e.preventDefault();
                                executeDbSql();
                            }}
                        >
                            Execute SQL
                        </Button>
                        {queryResult && (
                            <span className="flex flex-wrap items-center gap-3">
                                <span className="text-xs opacity-60">
                                    {queryResult.truncated
                                        ? `First ${queryResult.rows.length.toLocaleString()} rows shown, export for all of them`
                                        : `${queryResult.rows.length} row${queryResult.rows.length !== 1 ? "s" : ""} returned`}
                                </span>
                                {queryResult.columns?.length > 0 && <ExportButtons database={selectedDb} sql={ranSql} />}
                            </span>
                        )}
                    </div>
                    {queryError !== "" && <AlertMessage message={queryError} onClose={() => setQueryError("")} />}
                </div>
                {queryResult && queryResult.rows.length > 0 && (
                    <div className="mt-3 overflow-auto border border-neutral-200 max-h-96">
                        <CsvTable columns={queryResult.columns} rows={queryResult.rows} />
                    </div>
                )}
                {queryResult && queryResult.rows.length === 0 && (
                    <div className="mt-3 px-3 py-2 text-sm text-neutral-500 border border-neutral-200 bg-neutral-50">
                        {queryResult.command && queryResult.command !== "SELECT"
                            ? `${queryResult.command} changed ${(queryResult.rowCount ?? 0).toLocaleString()} row${queryResult.rowCount === 1 ? "" : "s"}`
                            : "Query executed successfully — no rows returned."}
                    </div>
                )}
            </div>
        </div>
    );
}
