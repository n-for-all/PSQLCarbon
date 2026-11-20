import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BookmarkIcon, CheckCircleIcon, HistoryIcon, SearchIcon, TrashIcon, XCircleIcon } from "@primer/octicons-react";
import { Button } from "~/ui/button";

interface HistoryEntry {
    id: string;
    createdAt: string;
    sql: string;
    database: string;
    success: boolean;
    error: string | null;
    rowCount: number | null;
    durationMs: number | null;
}

interface SavedEntry {
    id: string;
    updatedAt: string;
    name: string;
    sql: string;
    database: string;
}

interface QueryLibraryProps {
    /** The editor's database, lists default to it */
    database?: string;
    /** Current editor SQL, used by Save */
    sql: string;
    onLoad: (sql: string) => void;
    /** Shown on the left of the History / Saved buttons, on the same line */
    title?: ReactNode;
    /** Changes after every run so an open history list refreshes */
    refreshKey?: unknown;
}

const formatTime = (value: string) => {
    const date = new Date(value);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const post = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/queries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Something went wrong");
    return data;
};

export const QueryLibrary = ({ database, sql, onLoad, refreshKey, title }: QueryLibraryProps) => {
    const [panel, setPanel] = useState<"history" | "saved" | "save" | null>(null);
    const [search, setSearch] = useState("");
    const [thisDatabase, setThisDatabase] = useState(true);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [saved, setSaved] = useState<SavedEntry[]>([]);
    const [name, setName] = useState("");
    const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        if (panel !== "history" && panel !== "saved") return;
        setLoading(true);
        try {
            const params = new URLSearchParams({ kind: panel, q: search });
            if (thisDatabase && database) params.set("database", database);
            const response = await fetch(`/api/queries?${params}`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.message);
            if (panel === "history") setHistory(data.history);
            else setSaved(data.saved);
        } catch (e: any) {
            setMessage({ type: "error", text: e.message || "Could not load queries" });
        } finally {
            setLoading(false);
        }
    }, [panel, search, thisDatabase, database]);

    useEffect(() => {
        const timer = setTimeout(load, search ? 250 : 0);
        return () => clearTimeout(timer);
    }, [load, refreshKey]);

    const toggle = (next: "history" | "saved" | "save") => {
        setMessage(null);
        setPanel(panel === next ? null : next);
    };

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const data = await post({ intent: "save", name, sql, database });
            setMessage({ type: "success", text: data.replaced ? `Updated "${name}"` : `Saved as "${name}"` });
            setName("");
            setPanel("saved");
        } catch (error: any) {
            setMessage({ type: "error", text: error.message });
        }
    };

    const remove = async (intent: "delete_saved" | "delete_history", id: string) => {
        try {
            await post({ intent, id });
            if (intent === "delete_saved") setSaved((prev) => prev.filter((entry) => entry.id !== id));
            else setHistory((prev) => prev.filter((entry) => entry.id !== id));
        } catch (error: any) {
            setMessage({ type: "error", text: error.message });
        }
    };

    const clearHistory = async () => {
        if (!window.confirm("Clear the whole query history of this connection?")) return;
        try {
            await post({ intent: "clear_history" });
            setHistory([]);
        } catch (error: any) {
            setMessage({ type: "error", text: error.message });
        }
    };

    const tabClass = (active: boolean) => `flex items-center gap-1 px-2 py-1 text-xs font-medium border ${active ? "bg-white border-neutral-300 text-neutral-900" : "border-transparent text-neutral-600 hover:text-neutral-900"}`;
    const entryClass = "flex items-start gap-2 px-2 py-1.5 border-t border-neutral-100 first:border-t-0 hover:bg-neutral-50 group";

    return (
        <div className="mb-2">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">{title}</div>
                <div className="flex items-center gap-1 ml-auto">
                    <button type="button" className={tabClass(panel === "history")} onClick={() => toggle("history")}>
                        <HistoryIcon size={12} /> History
                    </button>
                    <button type="button" className={tabClass(panel === "saved")} onClick={() => toggle("saved")}>
                        <BookmarkIcon size={12} /> Saved
                    </button>
                    <button type="button" className={tabClass(panel === "save")} onClick={() => toggle("save")} disabled={!sql.trim()} title={sql.trim() ? "Save the current query" : "Write a query to save it"}>
                        + Save query
                    </button>
                </div>
            </div>

            {message && <div className={`mt-1 px-2 py-1 text-xs ${message.type === "error" ? "text-red-700 bg-red-50" : "text-green-800 bg-green-50"}`}>{message.text}</div>}

            {panel === "save" && (
                <form onSubmit={save} className="flex items-center gap-2 p-2 mt-1 border bg-neutral-50 border-neutral-200">
                    <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Name, e.g. Active users this week"
                        className="flex-1 min-w-0 px-2 py-1 text-sm bg-white border border-neutral-300 focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <Button size="xs" type="submit" disabled={!name.trim() || !sql.trim()}>
                        Save
                    </Button>
                </form>
            )}

            {(panel === "history" || panel === "saved") && (
                <div className="mt-1 border bg-white border-neutral-200">
                    <div className="flex flex-wrap items-center gap-2 p-2 border-b border-neutral-200 bg-neutral-50">
                        <div className="relative flex-1 min-w-[160px]">
                            <span className="absolute -translate-y-1/2 left-2 top-1/2 text-neutral-400">
                                <SearchIcon size={12} />
                            </span>
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={panel === "history" ? "Search history…" : "Search saved queries…"}
                                className="w-full py-1 pl-6 pr-2 text-xs bg-white border border-neutral-300 focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                        </div>
                        {database && (
                            <label className="flex items-center gap-1 text-xs text-neutral-600">
                                <input type="checkbox" checked={thisDatabase} onChange={(e) => setThisDatabase(e.target.checked)} />
                                Only {database}
                            </label>
                        )}
                        {panel === "history" && history.length > 0 && (
                            <button type="button" onClick={clearHistory} className="text-xs text-neutral-500 hover:text-red-600">
                                Clear history
                            </button>
                        )}
                    </div>

                    <div className="overflow-auto max-h-64">
                        {loading && (panel === "history" ? history : saved).length === 0 && <div className="p-3 text-xs text-neutral-500">Loading…</div>}
                        {!loading && panel === "history" && history.length === 0 && <div className="p-3 text-xs text-neutral-500">No queries yet. Queries you run show up here.</div>}
                        {!loading && panel === "saved" && saved.length === 0 && <div className="p-3 text-xs text-neutral-500">No saved queries yet. Use "+ Save query" to keep one.</div>}

                        {panel === "history" &&
                            history.map((entry) => (
                                <div key={entry.id} className={entryClass}>
                                    <span className={`mt-0.5 shrink-0 ${entry.success ? "text-green-600" : "text-red-600"}`} title={entry.success ? "Succeeded" : entry.error || "Failed"}>
                                        {entry.success ? <CheckCircleIcon size={12} /> : <XCircleIcon size={12} />}
                                    </span>
                                    <button type="button" onClick={() => onLoad(entry.sql)} className="flex-1 min-w-0 text-left" title="Load into the editor">
                                        <div className="font-mono text-xs break-all line-clamp-2 text-neutral-800">{entry.sql}</div>
                                        <div className="text-[11px] text-neutral-500">
                                            {formatTime(entry.createdAt)} · {entry.database}
                                            {entry.success ? `${entry.rowCount != null ? ` · ${entry.rowCount} ${entry.rowCount === 1 ? "row" : "rows"}` : ""}${entry.durationMs != null ? ` · ${entry.durationMs}ms` : ""}` : ` · ${entry.error}`}
                                        </div>
                                    </button>
                                    <button type="button" onClick={() => remove("delete_history", entry.id)} className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-600" aria-label="Remove from history">
                                        <TrashIcon size={12} />
                                    </button>
                                </div>
                            ))}

                        {panel === "saved" &&
                            saved.map((entry) => (
                                <div key={entry.id} className={entryClass}>
                                    <button type="button" onClick={() => onLoad(entry.sql)} className="flex-1 min-w-0 text-left" title="Load into the editor">
                                        <div className="text-xs font-medium text-neutral-900">{entry.name}</div>
                                        <div className="font-mono text-xs break-all line-clamp-2 text-neutral-600">{entry.sql}</div>
                                        <div className="text-[11px] text-neutral-500">
                                            {formatTime(entry.updatedAt)}
                                            {entry.database ? ` · ${entry.database}` : ""}
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => window.confirm(`Delete the saved query "${entry.name}"?`) && remove("delete_saved", entry.id)}
                                        className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-600"
                                        aria-label="Delete saved query">
                                        <TrashIcon size={12} />
                                    </button>
                                </div>
                            ))}
                    </div>
                </div>
            )}
        </div>
    );
};
