import { useState } from "react";
import { DownloadIcon } from "@primer/octicons-react";
import { downloadFile, formatBytes } from "~/utils/download";

/**
 * Downloads every row of a query as CSV or JSON, the query runs again on the server read only
 */
export const ExportButtons = ({ database, sql }: { database?: string; sql: string }) => {
    const [state, setState] = useState<{ format?: string; bytes?: number; error?: string }>({});

    const run = async (format: "csv" | "json") => {
        if (!database || !sql.trim()) return;
        setState({ format, bytes: 0 });
        try {
            await downloadFile(
                "/api/export",
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ db: database, sql, format }) },
                (bytes) => setState({ format, bytes })
            );
            setState({});
        } catch (error: any) {
            setState({ error: error.message });
        }
    };

    const button = "flex items-center gap-1 px-2 py-1 text-xs border bg-white border-neutral-200 text-neutral-700 hover:bg-neutral-50 disabled:opacity-50";
    return (
        <span className="flex flex-wrap items-center gap-1" title="Download every row of this query, not only the ones shown">
            <span className="text-xs text-neutral-500">Export</span>
            <button type="button" className={button} disabled={!!state.format} onClick={() => run("csv")}>
                <DownloadIcon size={12} /> CSV
            </button>
            <button type="button" className={button} disabled={!!state.format} onClick={() => run("json")}>
                <DownloadIcon size={12} /> JSON
            </button>
            {state.format && <span className="text-xs text-neutral-500">{state.bytes ? formatBytes(state.bytes) : "Preparing…"}</span>}
            {state.error && <span className="text-xs text-red-600">{state.error}</span>}
        </span>
    );
};
