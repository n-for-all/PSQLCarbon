import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useRevalidator } from "@remix-run/react";
import { Button } from "~/ui/button";
import {
    AlertIcon,
    ArrowRightIcon,
    BookmarkIcon,
    CheckIcon,
    DownloadIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    DatabaseIcon,
    DependabotIcon,
    PersonIcon,
    SquareFillIcon,
    TableIcon,
    TrashIcon,
    XIcon,
} from "@primer/octicons-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/select";
import { CopyTextButton } from "~/components/copy_text";
import { ExportButtons } from "~/components/export-buttons";
import { downloadFile, formatBytes } from "~/utils/download";

// Mirrors ChatMessage / ToolDisplay in app/lib/ai, these come from /api/chat
interface ToolCall {
    id: string;
    function: { name: string; arguments: string };
}

interface ResultSet {
    command: string;
    rowCount: number | null;
    columns: string[];
    rows: unknown[][];
    truncated: boolean;
}

interface ToolDisplay {
    tool: string;
    sql?: string;
    database?: string;
    results?: ResultSet[];
    write?: boolean;
    durationMs?: number;
    error?: string;
    rejected?: boolean;
    skipped?: boolean;
    text?: string;
    download?: { kind: "export"; database: string; sql: string; format: "csv" | "json" } | { kind: "backup"; database: string; content: "all" | "schema" | "data"; gzip: boolean };
}

interface ChatMessage {
    role: "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    display?: ToolDisplay;
}

interface SessionInfo {
    id: string;
    title: string;
    database: string;
}

interface Memory {
    id: string;
    content: string;
}

type WriteMode = "read_only" | "ask" | "auto";

interface AiChatPanelProps {
    db: string;
    table: string;
    columns?: string[];
}

const WRITE_MODE_LABELS: Record<WriteMode, string> = {
    read_only: "Read only",
    ask: "Ask before changes",
    auto: "Run changes automatically",
};

const parseArgs = (call: ToolCall): any => {
    try {
        return JSON.parse(call.function.arguments || "{}");
    } catch {
        return {};
    }
};

const unansweredToolCalls = (messages: ChatMessage[]) => {
    const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
    if (lastAssistant === -1 || !messages[lastAssistant].tool_calls?.length) return [];
    const answered = new Set(messages.slice(lastAssistant + 1).map((m) => m.tool_call_id));
    return messages[lastAssistant].tool_calls!.filter((call) => !answered.has(call.id));
};

const rowsLabel = (count: number) => `${count} ${count === 1 ? "row" : "rows"}`;

const formatCell = (value: unknown) => (value === null || value === undefined ? "NULL" : String(value));

const openInEditor = (sql: string) => window.dispatchEvent(new CustomEvent("ai-populate-editor", { detail: { sql } }));

const ResultTables = ({ results }: { results: ResultSet[] }) => (
    <div className="flex flex-col gap-2">
        {results.map((result, index) =>
            result.columns.length ? (
                <div key={index}>
                    <div className="overflow-auto border max-h-72 border-neutral-200">
                        <Table className="text-xs">
                            <TableHeader>
                                <TableRow>
                                    {result.columns.map((column, i) => (
                                        <TableHead key={i} className="whitespace-nowrap">
                                            {column}
                                        </TableHead>
                                    ))}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {result.rows.map((row, i) => (
                                    <TableRow key={i}>
                                        {row.map((cell, j) => (
                                            <TableCell key={j} className={`max-w-[240px] truncate ${cell === null ? "italic text-neutral-400" : ""}`} title={formatCell(cell)}>
                                                {formatCell(cell)}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                        {rowsLabel(result.rowCount ?? result.rows.length)}
                        {result.truncated ? `, showing the first ${result.rows.length}` : ""}
                    </div>
                </div>
            ) : (
                <div key={index} className="font-mono text-xs text-neutral-600">
                    {result.command} {result.rowCount ?? ""}
                </div>
            )
        )}
    </div>
);

const ToolCard = ({
    call,
    result,
    database,
    running,
    awaitingApproval,
    onApprove,
}: {
    call: ToolCall;
    database: string;
    result?: ChatMessage;
    running: boolean;
    awaitingApproval: boolean;
    onApprove: (approved: boolean) => void;
}) => {
    const args = parseArgs(call);
    const display = result?.display;
    const isQuery = call.function.name === "run_query";
    const [open, setOpen] = useState(isQuery);

    const label =
        {
            run_query: args.purpose || "Run query",
            list_databases: "List databases",
            list_tables: args.schema ? `List tables in ${args.schema}` : "List tables",
            describe_table: `Describe ${args.schema || "public"}.${args.table}`,
            save_memory: "Save memory",
            export_query_results: `Export results (${(args.format || "csv").toUpperCase()})`,
            create_backup: `Back up ${args.database || "database"}`,
            forget_memory: "Forget memory",
        }[call.function.name] || call.function.name;

    let status: React.ReactNode = null;
    if (!result) {
        status = awaitingApproval ? <span className="text-amber-600">needs approval</span> : running ? <span className="animate-pulse">running…</span> : <span>not run</span>;
    } else if (display?.rejected) {
        status = <span className="text-neutral-500">rejected</span>;
    } else if (display?.skipped) {
        status = <span className="text-neutral-500">skipped</span>;
    } else if (display?.error) {
        status = <span className="text-red-600">error</span>;
    } else if (display?.text) {
        status = <span className="truncate">{display.text}</span>;
    } else if (display?.results?.length) {
        const last = display.results[display.results.length - 1];
        status = (
            <span>
                {last.columns.length ? rowsLabel(last.rowCount ?? last.rows.length) : `${last.command} ${last.rowCount ?? ""}`}
                {display.durationMs !== undefined ? ` · ${display.durationMs}ms` : ""}
            </span>
        );
    }

    const sql = args.sql || display?.sql;

    return (
        <div className={`my-2 border bg-white ${awaitingApproval ? "border-amber-400" : display?.error ? "border-red-200" : "border-neutral-200"}`}>
            <button type="button" onClick={() => setOpen(!open)} className="flex items-center w-full gap-2 px-2 py-1.5 text-xs text-left hover:bg-neutral-50">
                {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                {isQuery ? <DatabaseIcon size={12} /> : call.function.name.includes("memory") ? <BookmarkIcon size={12} /> : <TableIcon size={12} />}
                <span className="flex-1 min-w-0 font-medium truncate">{label}</span>
                {args.database && args.database !== database && <span className="px-1 text-[10px] text-neutral-600 bg-neutral-100 shrink-0">{args.database}</span>}
                {(display?.write || awaitingApproval) && <span className="px-1 text-[10px] font-semibold text-amber-700 bg-amber-100 uppercase">change</span>}
                <span className="text-neutral-500 shrink-0 max-w-[45%] truncate">{status}</span>
            </button>
            {/* Downloads stay visible even when the card is collapsed */}
            {display?.download && !display.error && (
                <div className="px-2 pb-2">
                    <DownloadButton download={display.download} />
                </div>
            )}
            {open && (
                <div className="flex flex-col gap-2 px-2 pb-2">
                    {sql && (
                        <>
                            <pre className="p-2 overflow-auto font-mono text-xs whitespace-pre-wrap max-h-48 bg-neutral-100 text-neutral-800">{sql}</pre>
                            <div className="flex gap-2">
                                <CopyTextButton size="xs" variant="outline" text={sql}>
                                    Copy
                                </CopyTextButton>
                                <Button size="xs" variant="outline" onClick={() => openInEditor(sql)}>
                                    Open in editor
                                </Button>
                            </div>
                        </>
                    )}
                    {call.function.name === "save_memory" && args.content && <p className="text-xs text-neutral-700">{args.content}</p>}
                    {display?.error && <p className="text-xs text-red-600 whitespace-pre-wrap">{display.error}</p>}
                    {display?.results && !display.error && <ResultTables results={display.results} />}
                    {isQuery && !display?.write && display?.results?.some((result) => result.columns.length) && sql && <ExportButtons database={display?.database || database} sql={sql} />}
                    {awaitingApproval && (
                        <div className="flex flex-col gap-2 p-2 text-xs border border-amber-200 bg-amber-50">
                            <div className="flex items-center gap-1 font-medium text-amber-800">
                                <AlertIcon size={12} /> This query changes data or schema on "{args.database || database}". Run it?
                            </div>
                            <div className="flex gap-2">
                                <Button size="xs" icon={<CheckIcon />} onClick={() => onApprove(true)}>
                                    Approve &amp; run
                                </Button>
                                <Button size="xs" variant="outline" icon={<XIcon />} onClick={() => onApprove(false)}>
                                    Reject
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

/**
 * Downloads an export or backup the assistant prepared, the file is made when it's clicked
 */
const DownloadButton = ({ download }: { download: NonNullable<ToolDisplay["download"]> }) => {
    const [state, setState] = useState<{ bytes?: number; running?: boolean; error?: string; done?: string }>({});
    const start = async () => {
        setState({ running: true, bytes: 0 });
        try {
            const result =
                download.kind === "export"
                    ? await downloadFile(
                          "/api/export",
                          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ db: download.database, sql: download.sql, format: download.format }) },
                          (bytes) => setState({ running: true, bytes })
                      )
                    : await downloadFile(
                          `/api/backup?${new URLSearchParams({ db: download.database, content: download.content, engine: "auto", gzip: download.gzip ? "1" : "0" })}`,
                          undefined,
                          (bytes) => setState({ running: true, bytes })
                      );
            setState({ done: `${result.name} (${formatBytes(result.bytes)})` });
        } catch (error: any) {
            setState({ error: error.message });
        }
    };
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" icon={<DownloadIcon />} loading={state.running} disabled={state.running} onClick={start}>
                {download.kind === "export" ? `Download ${download.format.toUpperCase()}` : "Download backup"}
            </Button>
            {state.running && <span className="text-xs text-neutral-500">{state.bytes ? formatBytes(state.bytes) : "Preparing…"}</span>}
            {state.done && <span className="text-xs text-green-700">Saved {state.done}</span>}
            {state.error && <span className="text-xs text-red-600">{state.error}</span>}
        </div>
    );
};

const AssistantText = ({ content }: { content: string }) => {
    const parts = content.split(/```(\w*)[^\S\n]*\n([\s\S]*?)```/g);
    const rendered: React.ReactNode[] = [];
    for (let i = 0; i < parts.length; i++) {
        if (i % 3 === 0) {
            if (parts[i].trim()) {
                rendered.push(
                    <p key={i} className="mb-2 break-words whitespace-pre-wrap last:mb-0">
                        {parts[i].trim()}
                    </p>
                );
            }
        } else if (i % 3 === 2) {
            const lang = parts[i - 1].toLowerCase();
            const code = parts[i].trim();
            rendered.push(
                <div key={i} className="p-2 my-2 border rounded bg-neutral-100 border-neutral-200">
                    {lang && <div className="mb-1 text-xs font-semibold tracking-wider uppercase text-neutral-400">{lang}</div>}
                    <pre className="mb-2 font-mono text-xs break-words whitespace-pre-wrap text-neutral-800">{code}</pre>
                    <div className="flex gap-2">
                        <CopyTextButton size="xs" variant="outline" text={code}>
                            Copy
                        </CopyTextButton>
                        {["sql", "postgresql", "postgres", "pgsql"].includes(lang) && (
                            <Button size="xs" variant="outline" onClick={() => openInEditor(code)}>
                                Open in editor
                            </Button>
                        )}
                    </div>
                </div>
            );
        }
    }
    return <>{rendered}</>;
};

export const AiChatPanel = ({ db, table }: AiChatPanelProps) => {
    const revalidator = useRevalidator();
    const [sessions, setSessions] = useState<(SessionInfo & { updatedAt?: string })[]>([]);
    const [memories, setMemories] = useState<Memory[]>([]);
    const [writeMode, setWriteMode] = useState<WriteMode>("ask");
    const [model, setModel] = useState("");
    const [configured, setConfigured] = useState(true);
    const [active, setActive] = useState<SessionInfo | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showMemories, setShowMemories] = useState(false);
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const abortRef = useRef<AbortController | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const database = active?.database || db;

    const loadOverview = useCallback(async () => {
        try {
            const response = await fetch(`/api/chat?database=${encodeURIComponent(database || "")}`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.message);
            setSessions(data.sessions);
            setMemories(data.memories);
            setWriteMode(data.settings.writeMode);
            setModel(data.settings.model);
            setConfigured(data.settings.configured);
        } catch (e: any) {
            setError(e.message || "Could not load chats");
        }
    }, [database]);

    const loadSession = useCallback(async (id: string) => {
        const response = await fetch(`/api/chat?session=${encodeURIComponent(id)}`);
        const data = await response.json();
        if (!response.ok) {
            setError(data.message);
            return;
        }
        setActive({ id: data.session.id, title: data.session.title, database: data.session.database });
        setMessages(data.session.messages);
    }, []);

    useEffect(() => {
        loadOverview();
    }, [loadOverview]);

    useEffect(() => {
        try {
            const saved = localStorage.getItem("ai_chat_history");
            if (saved) setHistory(JSON.parse(saved));
        } catch {
            // history is only a convenience
        }
    }, []);

    useEffect(() => {
        setTimeout(() => {
            if (scrollContainerRef.current) {
                scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
            }
        }, 10);
    }, [messages, running]);

    const stream = async (body: Record<string, unknown>) => {
        setRunning(true);
        setError(null);
        const controller = new AbortController();
        abortRef.current = controller;
        let sessionId = active?.id;
        let changed = false;

        try {
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!response.ok || !response.body) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.message || "Something went wrong");
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
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (!line) continue;
                    const event = JSON.parse(line);
                    if (event.type === "session") {
                        sessionId = event.session.id;
                        setActive(event.session);
                    } else if (event.type === "message") {
                        setMessages((prev) => [...prev, event.message]);
                        if (event.message.display?.write && event.message.display.results) changed = true;
                    } else if (event.type === "error") {
                        setError(event.message);
                    }
                }
            }
        } catch (e: any) {
            if (e?.name !== "AbortError") setError(e.message);
        } finally {
            abortRef.current = null;
            setRunning(false);
            // The server copy is the source of truth, it also has messages added before the stream started
            if (sessionId) await loadSession(sessionId);
            loadOverview();
            if (changed) revalidator.revalidate();
        }
    };

    const handleSubmit = (e?: React.FormEvent) => {
        e?.preventDefault();
        const prompt = input.trim();
        if (!prompt || running) return;

        setMessages((prev) => [...prev, { role: "user", content: prompt }]);
        setHistory((prev) => {
            const next = [...prev.filter((item) => item !== prompt), prompt].slice(-50);
            try {
                localStorage.setItem("ai_chat_history", JSON.stringify(next));
            } catch {
                // ignore
            }
            return next;
        });
        setHistoryIndex(-1);
        setInput("");
        stream({ intent: "send", sessionId: active?.id, prompt, database, table });
    };

    const resume = (toolCallId?: string, approved?: boolean) => {
        if (!active || running) return;
        stream({ intent: "resume", sessionId: active.id, toolCallId, approved, table });
    };

    const post = async (body: Record<string, unknown>) => {
        const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            setError(data.message || "Something went wrong");
        }
    };

    const changeWriteMode = async (mode: WriteMode) => {
        setWriteMode(mode);
        await post({ intent: "settings", writeMode: mode });
    };

    const deleteSession = async () => {
        if (!active) return;
        await post({ intent: "delete_session", sessionId: active.id });
        setActive(null);
        setMessages([]);
        loadOverview();
    };

    const deleteMemory = async (id: string) => {
        setMemories((prev) => prev.filter((memory) => memory.id !== id));
        await post({ intent: "delete_memory", memoryId: id });
    };

    const newChat = () => {
        abortRef.current?.abort();
        setActive(null);
        setMessages([]);
        setError(null);
    };

    const unanswered = running ? [] : unansweredToolCalls(messages);
    const awaitingApprovalId = unanswered.find((call) => call.function.name === "run_query")?.id;
    const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m]));

    return (
        <div className="flex flex-col h-full bg-neutral-50">
            <div className="flex flex-col gap-2 p-3 border-b border-neutral-200">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center min-w-0 gap-2">
                        <DependabotIcon />
                        <h3 className="font-bold text-md">AI Assistant</h3>
                        {model && <span className="text-xs truncate text-neutral-400">{model}</span>}
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                        <button type="button" onClick={() => setShowMemories(!showMemories)} className="flex items-center gap-1 font-medium text-neutral-500 hover:text-neutral-900">
                            <BookmarkIcon size={12} /> Memory ({memories.length})
                        </button>
                        {active && (
                            <button type="button" onClick={deleteSession} disabled={running} className="font-medium text-neutral-500 hover:text-red-500">
                                Delete chat
                            </button>
                        )}
                    </div>
                </div>
                <div className="flex gap-2">
                    <Select value={active?.id || "new"} onValueChange={(value) => (value === "new" ? newChat() : loadSession(value))} disabled={running}>
                        <SelectTrigger className="flex-1 h-8 min-w-0 text-xs font-semibold bg-white">
                            <SelectValue placeholder="Select a chat" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="new" className="font-bold text-primary">
                                + New chat
                            </SelectItem>
                            {sessions.map((session) => (
                                <SelectItem key={session.id} value={session.id}>
                                    {session.title} <span className="text-neutral-400">· {session.database}</span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={writeMode} onValueChange={(value) => changeWriteMode(value as WriteMode)}>
                        <SelectTrigger className="h-8 text-xs bg-white w-44 shrink-0" title="What the assistant may do with queries that change data or schema">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {(Object.keys(WRITE_MODE_LABELS) as WriteMode[]).map((mode) => (
                                <SelectItem key={mode} value={mode}>
                                    {WRITE_MODE_LABELS[mode]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex items-center min-w-0 gap-1 text-xs text-neutral-500" title="The chat starts on this database, the assistant can also use the other databases on this connection">
                    <DatabaseIcon size={12} className="shrink-0" />
                    <span className="truncate">
                        {database || "default database"} <span className="text-neutral-400">· and other databases</span>
                    </span>
                </div>
                {showMemories && (
                    <div className="p-2 text-xs bg-white border border-neutral-200">
                        <div className="mb-1 font-semibold">Saved about {database || "this database"}</div>
                        {memories.length === 0 && <div className="text-neutral-500">Nothing yet. Ask the assistant to remember something, or it saves useful facts as it learns them.</div>}
                        {memories.map((memory) => (
                            <div key={memory.id} className="flex items-start gap-2 py-1 border-t first:border-t-0 border-neutral-100">
                                <span className="flex-1">{memory.content}</span>
                                <button type="button" onClick={() => deleteMemory(memory.id)} className="text-neutral-400 hover:text-red-500" aria-label="Delete memory">
                                    <TrashIcon size={12} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div ref={scrollContainerRef} className="flex-1 p-4 space-y-4 overflow-auto">
                {!configured && (
                    <div className="p-3 text-sm border border-amber-200 bg-amber-50">
                        Add your AI API key in{" "}
                        <Link to="/profile" className="underline">
                            Profile settings
                        </Link>{" "}
                        to use the assistant.
                    </div>
                )}
                {messages.length === 0 && configured && (
                    <div className="mt-10 text-sm text-center text-neutral-500">
                        Ask anything about your data. The assistant looks at your tables and runs queries itself
                        {writeMode === "ask" ? ", and asks before changing anything." : writeMode === "read_only" ? ", it can't change anything." : "."}
                    </div>
                )}
                {messages.map((msg, idx) => {
                    if (msg.role === "tool") return null;
                    if (msg.role === "user") {
                        return (
                            <div key={idx} className="flex justify-end">
                                <div className="flex flex-row-reverse max-w-[90%] gap-2">
                                    <div className="flex-shrink-0 mt-1 text-neutral-500">
                                        <PersonIcon />
                                    </div>
                                    <div className="p-3 text-sm break-words whitespace-pre-wrap rounded-lg text-primary-foreground bg-primary">{msg.content}</div>
                                </div>
                            </div>
                        );
                    }
                    return (
                        <div key={idx} className="flex justify-start">
                            <div className="flex w-full gap-2">
                                <div className="flex-shrink-0 mt-1 text-neutral-500">
                                    <DependabotIcon />
                                </div>
                                <div className="flex-1 min-w-0 text-sm">
                                    {msg.content && (
                                        <div className="p-3 bg-white border rounded-lg border-neutral-200">
                                            <AssistantText content={msg.content} />
                                        </div>
                                    )}
                                    {msg.tool_calls?.map((call) => (
                                        <ToolCard
                                            key={call.id}
                                            call={call}
                                            result={results.get(call.id)}
                                            database={database}
                                            running={running}
                                            awaitingApproval={call.id === awaitingApprovalId}
                                            onApprove={(approved) => resume(call.id, approved)}
                                        />
                                    ))}
                                </div>
                            </div>
                        </div>
                    );
                })}
                {running && (
                    <div className="flex gap-2 text-sm text-neutral-500">
                        <DependabotIcon />
                        <span className="animate-pulse">Working…</span>
                    </div>
                )}
                {!running && unanswered.length > 0 && !awaitingApprovalId && (
                    <Button size="xs" variant="outline" onClick={() => resume()}>
                        Continue
                    </Button>
                )}
                {error && <div className="p-2 text-xs text-red-600 break-words whitespace-pre-wrap border border-red-200 bg-red-50">{error}</div>}
            </div>

            <div className="p-3 bg-white border-t border-neutral-200">
                <form onSubmit={handleSubmit} className="relative flex">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                handleSubmit();
                                return;
                            }
                            if (e.key === "ArrowUp" && !input.includes("\n")) {
                                e.preventDefault();
                                if (history.length > 0) {
                                    const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
                                    setHistoryIndex(newIndex);
                                    setInput(history[history.length - 1 - newIndex]);
                                }
                            } else if (e.key === "ArrowDown" && !input.includes("\n")) {
                                e.preventDefault();
                                if (historyIndex > 0) {
                                    const newIndex = historyIndex - 1;
                                    setHistoryIndex(newIndex);
                                    setInput(history[history.length - 1 - newIndex]);
                                } else if (historyIndex === 0) {
                                    setHistoryIndex(-1);
                                    setInput("");
                                }
                            }
                        }}
                        className="w-full font-sans resize-none min-h-[80px] p-3 pr-14 text-sm bg-neutral-50 border border-neutral-300 focus:outline-none focus:ring-1 focus:ring-primary/400"
                        placeholder={awaitingApprovalId ? "Approve or reject the change above, or type a new message to skip it…" : "Ask anything about your database…"}
                    />
                    <div className="absolute right-2 bottom-2">
                        {running ? (
                            <Button size="sm" type="button" variant="error" onClick={() => abortRef.current?.abort()} icon={<SquareFillIcon />} hasIconOnly tooltip="Stop" />
                        ) : (
                            <Button size="sm" type="submit" disabled={!input.trim()} icon={<ArrowRightIcon />} hasIconOnly />
                        )}
                    </div>
                </form>
            </div>
        </div>
    );
};
