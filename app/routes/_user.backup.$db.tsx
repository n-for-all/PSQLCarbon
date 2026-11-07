import { LoaderFunction, redirect } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { useRef, useState } from "react";
import { AlertIcon, CheckCircleIcon, DownloadIcon, UploadIcon, XCircleIcon } from "@primer/octicons-react";
import db from "~/lib/db";
import { findPgTool, serverVersion } from "~/lib/backup.server";
import { getSessionConnection } from "~/utils/session.server";
import { Button } from "~/ui/button";
import Modal from "~/ui/modal";
import { DatabaseTabs } from "~/components/database-tabs";

interface ToolInfo {
    version: string;
    major: number;
    compatible: boolean;
    /** Shipped with the desktop app rather than installed on the machine */
    bundled: boolean;
}

interface LoaderData {
    database: string;
    server: string;
    pgDump: ToolInfo | null;
    pgRestore: ToolInfo | null;
}

export const loader: LoaderFunction = async ({ request, params }) => {
    const connection = await getSessionConnection(request);
    if (!connection) throw redirect("/connections");
    const mongo = await db(connection);
    const pool = mongo.getPool(params.db!);
    if (!pool) throw redirect("/");

    const [server, dump, restore] = await Promise.all([serverVersion(pool), findPgTool("pg_dump"), findPgTool("pg_restore")]);
    const info = (tool: Awaited<ReturnType<typeof findPgTool>>): ToolInfo | null => (tool
            ? { version: tool.version, major: tool.major, compatible: tool.major >= server.major, bundled: !!process.env.PSQLCARBON_PG_TOOLS && tool.path.startsWith(process.env.PSQLCARBON_PG_TOOLS) }
            : null);
    const data: LoaderData = { database: params.db!, server: server.version, pgDump: info(dump), pgRestore: info(restore) };
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
};

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`);

type LogLine = { level: "info" | "warning" | "error"; message: string };

const Choice = ({ checked, disabled, onChange, title, description }: { checked: boolean; disabled?: boolean; onChange: () => void; title: string; description?: string }) => (
    <label className={`flex items-start gap-2 p-2 border cursor-pointer ${checked ? "border-primary bg-blue-50/50" : "border-neutral-200 bg-white"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}>
        <input type="radio" className="mt-1" checked={checked} disabled={disabled} onChange={onChange} />
        <span>
            <span className="block text-sm font-medium">{title}</span>
            {description && <span className="block text-xs text-neutral-500">{description}</span>}
        </span>
    </label>
);

export default function BackupPage() {
    const data = useLoaderData<LoaderData>();
    const pgDumpUsable = !!data.pgDump?.compatible;

    // Backup
    const [content, setContent] = useState<"all" | "schema" | "data">("all");
    const [engine, setEngine] = useState<"auto" | "builtin" | "pg_dump">("auto");
    const [format, setFormat] = useState<"plain" | "custom">("plain");
    const [gzip, setGzip] = useState(false);
    const [download, setDownload] = useState<{ bytes: number; running: boolean; error?: string; done?: string } | null>(null);
    const effectiveEngine = engine === "builtin" || (engine === "auto" && !pgDumpUsable) ? "builtin" : "pg_dump";

    // Restore
    const [file, setFile] = useState<File | null>(null);
    const [target, setTarget] = useState<"existing" | "new">("new");
    const [newName, setNewName] = useState(`${data.database}_restored`);
    const [singleTransaction, setSingleTransaction] = useState(true);
    const [skipOwnership, setSkipOwnership] = useState(true);
    const [confirming, setConfirming] = useState(false);
    const revalidator = useRevalidator();
    const [restore, setRestore] = useState<{ running: boolean; bytes: number; total: number | null; statements: number; rows: number; result?: { ok: boolean; message: string; database: string } } | null>(null);
    const [log, setLog] = useState<LogLine[]>([]);
    const abortRef = useRef<AbortController | null>(null);

    const startDownload = async () => {
        const params = new URLSearchParams({ db: data.database, content, engine, format: effectiveEngine === "pg_dump" ? format : "plain", gzip: gzip ? "1" : "0" });
        setDownload({ bytes: 0, running: true });
        try {
            const response = await fetch(`/api/backup?${params}`);
            if (!response.ok || !response.body) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.message || "The backup failed");
            }
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(value);
                bytes += value.length;
                setDownload({ bytes, running: true });
            }
            const blob = new Blob(chunks as BlobPart[]);
            // A plain built-in backup ends with a marker, an error part way leaves a message instead
            const tail = await blob.slice(Math.max(0, blob.size - 2048)).text();
            const failed = /-- BACKUP FAILED: (.*)/.exec(tail);
            if (failed) throw new Error(failed[1]);

            const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "")?.[1] || `${data.database}.sql`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            setDownload({ bytes, running: false, done: `${name} (${formatBytes(bytes)}) made with ${response.headers.get("X-Backup-Engine") || "the built-in engine"}` });
        } catch (e: any) {
            setDownload({ bytes: 0, running: false, error: e.message === "network error" || e.name === "TypeError" ? "The backup was interrupted" : e.message });
        }
    };

    const startRestore = async () => {
        if (!file) return;
        setConfirming(false);
        setLog([]);
        setRestore({ running: true, bytes: 0, total: file.size, statements: 0, rows: 0 });
        const params = new URLSearchParams({ db: data.database, target, newName, singleTransaction: singleTransaction ? "1" : "0", skipOwnership: skipOwnership ? "1" : "0" });
        const controller = new AbortController();
        abortRef.current = controller;
        const restoredInto = target === "new" ? newName : data.database;
        try {
            const response = await fetch(`/api/backup?${params}`, { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" }, signal: controller.signal });
            if (!response.ok || !response.body) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.message || "The restore failed");
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newline;
                while ((newline = buffer.indexOf("\n")) >= 0) {
                    const event = JSON.parse(buffer.slice(0, newline));
                    buffer = buffer.slice(newline + 1);
                    if (event.type === "log") setLog((prev) => [...prev.slice(-300), { level: event.level || "info", message: event.message }]);
                    else if (event.type === "progress") setRestore((prev) => prev && { ...prev, bytes: event.bytes, statements: event.statements, rows: event.rows });
                    else if (event.type === "done") setRestore((prev) => prev && { ...prev, running: false, result: { ok: event.ok, message: event.message, database: restoredInto } });
                }
            }
            setRestore((prev) => prev && { ...prev, running: false, result: prev.result || { ok: false, message: "The restore stopped without finishing", database: restoredInto } });
        } catch (e: any) {
            setRestore((prev) => ({ running: false, bytes: prev?.bytes || 0, total: prev?.total || null, statements: prev?.statements || 0, rows: prev?.rows || 0, result: { ok: false, message: e.name === "AbortError" ? "Restore cancelled" : e.message, database: restoredInto } }));
        } finally {
            abortRef.current = null;
            // The sidebar lists databases and tables, a restore can add both (even one that failed partway)
            revalidator.revalidate();
        }
    };

    const isArchive = !!file && /\.(dump|backup|custom)$/i.test(file.name);

    return (
        <div className="max-w-4xl">
            <DatabaseTabs database={data.database} active="backup" />
            <div className="pb-4">
                <p className="text-xs text-neutral-500">
                    PostgreSQL {data.server} ·{" "}
                    {data.pgDump
                        ? data.pgDump.compatible
                            ? `pg_dump ${data.pgDump.version} ${data.pgDump.bundled ? "included with the app" : "available on the server"}`
                            : `pg_dump ${data.pgDump.version} found but it's older than the server, the built-in engine is used`
                        : "pg_dump isn't available on the server, the built-in engine is used (nothing to install)"}
                </p>
            </div>

            <section className="p-4 mb-4 bg-white border border-neutral-300">
                <h2 className="flex items-center gap-2 mb-3 font-semibold">
                    <DownloadIcon /> Backup
                </h2>
                <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-semibold uppercase text-neutral-500">Content</span>
                        <Choice checked={content === "all"} onChange={() => setContent("all")} title="Schema and data" />
                        <Choice checked={content === "schema"} onChange={() => setContent("schema")} title="Schema only" description="Tables, views, functions, indexes, no rows" />
                        <Choice checked={content === "data"} onChange={() => setContent("data")} title="Data only" description="Rows, for restoring into an existing schema" />
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-semibold uppercase text-neutral-500">Engine</span>
                        <Choice
                            checked={engine === "auto"}
                            onChange={() => setEngine("auto")}
                            title="Automatic"
                            description={pgDumpUsable ? "Uses pg_dump" : "Uses the built-in engine, pg_dump isn't usable here"}
                        />
                        <Choice checked={engine === "builtin"} onChange={() => setEngine("builtin")} title="Built-in" description="Plain SQL written by PSQLCarbon, restores anywhere" />
                        <Choice
                            checked={engine === "pg_dump"}
                            disabled={!pgDumpUsable}
                            onChange={() => setEngine("pg_dump")}
                            title="pg_dump"
                            description={pgDumpUsable ? `Version ${data.pgDump!.version}` : data.pgDump ? `Version ${data.pgDump.version} is too old for this server` : "Not installed on the server"}
                        />
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-4 mt-3 text-sm">
                    {effectiveEngine === "pg_dump" && (
                        <label className="flex items-center gap-2">
                            Format
                            <select className="px-2 py-1 text-sm border border-neutral-300" value={format} onChange={(e) => setFormat(e.target.value as "plain" | "custom")}>
                                <option value="plain">Plain SQL (.sql)</option>
                                <option value="custom">pg_dump archive (.dump)</option>
                            </select>
                        </label>
                    )}
                    {(effectiveEngine === "builtin" || format === "plain") && (
                        <label className="flex items-center gap-2">
                            <input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} /> Compress (.sql.gz)
                        </label>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-4">
                    <Button size="sm" icon={<DownloadIcon />} loading={download?.running} disabled={download?.running} onClick={startDownload}>
                        Download backup
                    </Button>
                    {download?.running && <span className="text-xs text-neutral-500">Downloading {formatBytes(download.bytes)}…</span>}
                    {download?.done && (
                        <span className="flex items-center gap-1 text-xs text-green-700">
                            <CheckCircleIcon size={12} /> {download.done}
                        </span>
                    )}
                    {download?.error && (
                        <span className="flex items-center gap-1 text-xs text-red-700">
                            <XCircleIcon size={12} /> {download.error}
                        </span>
                    )}
                </div>
            </section>

            <section className="p-4 bg-white border border-neutral-300">
                <h2 className="flex items-center gap-2 mb-3 font-semibold">
                    <UploadIcon /> Restore
                </h2>
                <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-semibold uppercase text-neutral-500">Backup file</span>
                        <input
                            type="file"
                            accept=".sql,.gz,.dump,.backup,.custom"
                            onChange={(e) => setFile(e.target.files?.[0] || null)}
                            className="text-sm file:mr-3 file:px-3 file:py-1.5 file:border file:border-neutral-300 file:bg-neutral-50 file:text-sm"
                        />
                        <span className="text-xs text-neutral-500">
                            .sql or .sql.gz from PSQLCarbon or pg_dump. pg_dump archives (.dump){" "}
                            {data.pgRestore ? `are restored with pg_restore ${data.pgRestore.version}` : "need pg_restore, which isn't available on this server"}.
                        </span>
                        {file && (
                            <span className="text-xs text-neutral-700">
                                {file.name} · {formatBytes(file.size)}
                            </span>
                        )}
                        {isArchive && !data.pgRestore && (
                            <span className="flex items-center gap-1 text-xs text-amber-700">
                                <AlertIcon size={12} /> This looks like a pg_dump archive, it can't be restored here without pg_restore
                            </span>
                        )}
                    </div>
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-semibold uppercase text-neutral-500">Restore into</span>
                        <Choice checked={target === "new"} onChange={() => setTarget("new")} title="A new database" description="Safest, nothing existing is touched" />
                        {target === "new" && (
                            <input value={newName} onChange={(e) => setNewName(e.target.value)} className="px-2 py-1 font-mono text-sm border border-neutral-300" placeholder="new_database" />
                        )}
                        <Choice checked={target === "existing"} onChange={() => setTarget("existing")} title={`This database (${data.database})`} description="Objects that already exist make the restore fail" />
                    </div>
                </div>
                <div className="flex flex-col gap-1 mt-3 text-sm">
                    <label className="flex items-center gap-2">
                        <input type="checkbox" checked={singleTransaction} onChange={(e) => setSingleTransaction(e.target.checked)} /> All or nothing: roll everything back if a statement fails
                    </label>
                    <label className="flex items-center gap-2">
                        <input type="checkbox" checked={skipOwnership} onChange={(e) => setSkipOwnership(e.target.checked)} /> Skip ownership and privileges (roles may not exist here)
                    </label>
                </div>
                <div className="flex items-center gap-3 mt-4">
                    <Button size="sm" icon={<UploadIcon />} disabled={!file || restore?.running || (target === "new" && !newName.trim())} onClick={() => setConfirming(true)}>
                        Restore
                    </Button>
                    {restore?.running && (
                        <Button size="sm" variant="outline" onClick={() => abortRef.current?.abort()}>
                            Cancel
                        </Button>
                    )}
                </div>

                {restore && (
                    <div className="mt-4">
                        <div className="h-2 overflow-hidden bg-neutral-100">
                            <div className={`h-full transition-all ${restore.result && !restore.result.ok ? "bg-red-500" : "bg-primary"}`} style={{ width: `${restore.total ? Math.min(100, (restore.bytes / restore.total) * 100) : restore.running ? 30 : 100}%` }} />
                        </div>
                        <div className="mt-1 text-xs text-neutral-500">
                            {formatBytes(restore.bytes)}
                            {restore.total ? ` of ${formatBytes(restore.total)}` : ""} · {restore.statements} statements · {restore.rows.toLocaleString()} rows
                        </div>
                        {restore.result && (
                            <div className={`flex items-start gap-2 p-2 mt-2 text-sm border ${restore.result.ok ? "text-green-800 bg-green-50 border-green-200" : "text-red-800 bg-red-50 border-red-200"}`}>
                                {restore.result.ok ? <CheckCircleIcon className="mt-0.5" /> : <XCircleIcon className="mt-0.5" />}
                                <span className="flex-1">
                                    {restore.result.message}
                                    {restore.result.ok && (
                                        <>
                                            {" "}
                                            <a href={`/database/${encodeURIComponent(restore.result.database)}`} className="underline">
                                                Open {restore.result.database}
                                            </a>
                                        </>
                                    )}
                                </span>
                            </div>
                        )}
                        {log.length > 0 && (
                            <div className="p-2 mt-2 overflow-auto font-mono text-xs border max-h-56 bg-neutral-50 border-neutral-200">
                                {log.map((line, i) => (
                                    <div key={i} className={line.level === "error" ? "text-red-700" : line.level === "warning" ? "text-amber-700" : "text-neutral-600"}>
                                        {line.message}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </section>

            <Modal
                open={confirming}
                danger={target === "existing"}
                modalHeading={target === "existing" ? `Restore into ${data.database}?` : `Restore into a new database?`}
                modalLabel="Restore"
                primaryButtonText="Restore"
                secondaryButtonText="Cancel"
                onClose={() => setConfirming(false)}
                onSecondaryClick={() => setConfirming(false)}
                onPrimaryClick={startRestore}>
                <p className="text-sm">
                    {target === "existing"
                        ? `The backup "${file?.name}" will run against the existing database "${data.database}". It can change or add data there.`
                        : `A new database "${newName}" will be created and "${file?.name}" restored into it.`}
                </p>
            </Modal>
        </div>
    );
}
