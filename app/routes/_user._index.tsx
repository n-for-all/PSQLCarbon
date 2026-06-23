import { LoaderFunction, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import db, { ConnectionData } from "~/lib/db";
import { Table, TableBody, TableCell, TableRow } from "~/ui/table";
import { getUserSession } from "~/utils/session.server";
import { Editor } from "@monaco-editor/react";
import { AlertMessage } from "~/components/alert";
import { CsvTable } from "~/components/csv_table";
import { useState, useEffect, SyntheticEvent } from "react";
import { Button } from "~/ui/button";
import { ArrowRightIcon } from "@primer/octicons-react";
import { Terminal } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/select";

export const loader: LoaderFunction = async ({ request }) => {
    const session = await getUserSession(request);
    const connection = session.get("connection");
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
            const res = await pool.query("SELECT version();");
            version = res.rows[0].version;

            // Try to get uptime if pg_postmaster_start_time is available
            const uptimeRes = await pool.query("SELECT extract(epoch from (now() - pg_postmaster_start_time())) as uptime;");
            uptime = uptimeRes.rows[0].uptime;
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
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    if (!mounted) {
        return <div className="min-h-[150px] border border-neutral-200 p-4 text-xs text-neutral-500">Loading editor...</div>;
    }

    return (
        <Editor
            height="150px"
            language="pgsql"
            theme="light"
            value={value}
            onChange={onChange}
            options={{
                minimap: { enabled: false },
                lineNumbers: "off",
                scrollBeyondLastLine: false,
                wordWrap: "on",
                fontSize: 13,
            }}
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
    const [queryResult, setQueryResult] = useState<{ columns: string[]; rows: any[] } | null>(null);
    const queryLoading = queryFetcher.state === "submitting" || queryFetcher.state === "loading";

    useEffect(() => {
        if (!queryFetcher.data) return;
        if (queryFetcher.data.message) {
            setQueryError(queryFetcher.data.message);
            setQueryResult(null);
        } else {
            setQueryError("");
            setQueryResult({ columns: queryFetcher.data.columns || [], rows: queryFetcher.data.rows || [] });
        }
    }, [queryFetcher.data]);

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
            <div className="flex flex-col pb-4 lg:flex-row">
                <div className="flex-1 w-full">
                    <Table className="flex-1 w-full bg-neutral-100 text-md">
                        <TableBody>
                            <TableRow className="border-b">
                                <TableCell className="px-4 py-2 font-semibold">Node Version</TableCell>
                                <TableCell className="px-4 py-2">{versions?.node}</TableCell>
                            </TableRow>
                            <TableRow className="border-b">
                                <TableCell className="px-4 py-2 font-semibold">V8 Version</TableCell>
                                <TableCell className="px-4 py-2">{versions?.v8}</TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>
                <div className="flex-1 w-full">
                    <Table className="bg-neutral-100 text-md">
                        <TableBody>
                            <TableRow className="border-b">
                                <TableCell className="px-4 py-2 font-semibold">Uptime</TableCell>
                                <TableCell className="px-4 py-2">
                                    {info?.uptime} seconds
                                </TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>
            </div>

            {/* ── Server-level Query Editor ── */}
            <div className="p-4 mt-1 mb-4 border border-solid border-neutral-300">
                <div className="flex items-center justify-between py-1 mb-2">
                    <div>
                        <span className="flex items-center gap-1 text-base font-bold">
                            <Terminal size={15} />
                            Global Query Editor
                        </span>
                        <span className="block text-xs opacity-50">Run SQL queries against any database on this server</span>
                    </div>
                    {databases.length > 0 && (
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">Database:</span>
                            <Select value={selectedDb} onValueChange={(val) => setSelectedDb(val)}>
                                <SelectTrigger className="w-[200px] h-8 bg-white">
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
                            <span className="text-xs opacity-60">
                                {queryResult.rows.length} row{queryResult.rows.length !== 1 ? "s" : ""} returned
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
                        Query executed successfully — no rows returned.
                    </div>
                )}
            </div>
        </div>
    );
}
