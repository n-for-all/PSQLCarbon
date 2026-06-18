import { useState, useRef, useEffect } from "react";
import { useRevalidator } from "@remix-run/react";
import { Button } from "~/ui/button";
import { ArrowRightIcon, DependabotIcon, PersonIcon, PlayIcon } from "@primer/octicons-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/ui/select";
import { CopyTextButton } from "~/components/copy_text";

interface ChatSession {
    id: string;
    title: string;
    messages: { role: "user" | "ai" | "system"; content: any }[];
    updatedAt: number;
}

interface AiChatPanelProps {
    db: string;
    table: string;
    columns: string[];
}

const checkIsModifying = (sql: string) => {
    const cleanSql = sql
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();
    return /^(UPDATE|DELETE|INSERT|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CREATE|REPLACE)\b/i.test(cleanSql);
};

export const AiChatPanel = ({ db, table, columns }: AiChatPanelProps) => {
    const revalidator = useRevalidator();
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [messages, setMessages] = useState<{ role: "user" | "ai" | "system"; content: any }[]>([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);

    useEffect(() => {
        const savedSessions = localStorage.getItem("ai_chat_sessions");
        if (savedSessions) {
            try {
                const parsed = JSON.parse(savedSessions);
                setSessions(parsed);
                if (parsed.length > 0) {
                    setActiveSessionId(parsed[0].id);
                    setMessages(parsed[0].messages);
                }
            } catch (e) {
                console.error("Failed to parse saved chat sessions", e);
            }
        } else {
            // Migration for older clients that just had ai_chat_messages
            const savedMessages = localStorage.getItem("ai_chat_messages");
            if (savedMessages) {
                try {
                    const parsedMessages = JSON.parse(savedMessages);
                    if (parsedMessages.length > 0) {
                        const newSession = {
                            id: Date.now().toString(),
                            title: "Previous Chat",
                            messages: parsedMessages,
                            updatedAt: Date.now()
                        };
                        setSessions([newSession]);
                        setActiveSessionId(newSession.id);
                        setMessages(parsedMessages);
                    }
                } catch (e) {}
            }
        }
        
        const savedHistory = localStorage.getItem("ai_chat_history");
        if (savedHistory) {
            try {
                setHistory(JSON.parse(savedHistory));
            } catch (e) {}
        }
    }, []);

    useEffect(() => {
        if (sessions.length > 0) {
            localStorage.setItem("ai_chat_sessions", JSON.stringify(sessions));
        } else {
            localStorage.removeItem("ai_chat_sessions");
        }
    }, [sessions]);

    // Keep sessions array updated when active messages change
    useEffect(() => {
        if (activeSessionId) {
            setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, messages, updatedAt: Date.now() } : s));
        }
    }, [messages, activeSessionId]);

    useEffect(() => {
        if (history.length > 0) {
            localStorage.setItem("ai_chat_history", JSON.stringify(history));
        }
    }, [history]);

    const scrollContainerRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        setTimeout(() => {
            if (scrollContainerRef.current) {
                scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
            }
        }, 10);
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, loading]);

    const handleExecuteInternal = async (sql: string) => {
        const isModifying = checkIsModifying(sql);
        if (isModifying) {
            window.dispatchEvent(new CustomEvent("ai-populate-editor", { detail: { sql } }));
            setMessages((prev) => [...prev, { role: "system", content: "I've populated the query editor with your statement. You can review and execute it from there." }]);
            return;
        }
        await doExecuteSql(sql);
    };

    const doExecuteSql = async (sql: string) => {
        setMessages((prev) => [...prev, { role: "system", content: `Executing: ${sql}` }]);
        try {
            const response = await fetch("/api/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sql, db })
            });
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.message || "Failed to execute query");
            }
            
            if (data.columns && data.columns.length > 0) {
                setMessages((prev) => [...prev, { role: "system", content: { columns: data.columns, rows: data.rows.slice(0, 10), total: data.rows.length } }]);
            } else {
                setMessages((prev) => [...prev, { role: "system", content: `Success: ${data.rowCount} rows affected.` }]);
            }

            const isModifying = checkIsModifying(sql);
            if (isModifying) {
                revalidator.revalidate();
            }
        } catch (e: any) {
            setMessages((prev) => [...prev, { role: "system", content: `Error executing query: ${e.message}` }]);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim()) return;

        let sessionId = activeSessionId;
        if (!sessionId) {
            sessionId = Date.now().toString();
            const newTitle = input.length > 30 ? input.slice(0, 30) + "..." : input;
            const newSession: ChatSession = {
                id: sessionId,
                title: newTitle,
                messages: [],
                updatedAt: Date.now()
            };
            setSessions(prev => [newSession, ...prev]);
            setActiveSessionId(sessionId);
        }

        const userMessage = input;
        setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
        setHistory((prev) => [...prev, userMessage]);
        setHistoryIndex(-1);
        setInput("");
        setLoading(true);

        const chatHistory = messages
            .filter((m) => m.role === "user" || m.role === "ai")
            .map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.content }));

        try {
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    prompt: userMessage,
                    history: chatHistory,
                    db,
                    table,
                    columns,
                }),
            });

            if (!response.ok) {
                const err = await response.json();
                let errMsg = err.message || "Something went wrong";
                if (err.requestHeaders || err.responseHeaders) {
                    errMsg += `\n\nRequest Headers:\n${JSON.stringify(err.requestHeaders, null, 2)}`;
                    errMsg += `\n\nResponse Headers:\n${JSON.stringify(err.responseHeaders, null, 2)}`;
                }
                throw new Error(errMsg);
            }

            const data = await response.json();
            const aiMessage = data.sql || data.reply;
            setMessages((prev) => [...prev, { role: "ai", content: aiMessage }]);

            // Automatically execute SELECT queries
            const sqlMatch = aiMessage.match(/```(?:sql)?\s*?\n?([\s\S]*?)```/i);
            if (sqlMatch && sqlMatch[1]) {
                const sql = sqlMatch[1].trim();
                const isModifying = checkIsModifying(sql);
                if (!isModifying) {
                    await handleExecuteInternal(sql);
                }
            }
        } catch (e: any) {
            setMessages((prev) => [...prev, { role: "ai", content: `Error: ${e.message}` }]);
        } finally {
            setLoading(false);
        }
    };

    const createNewSession = () => {
        setActiveSessionId(null);
        setMessages([]);
    };

    const switchSession = (id: string) => {
        const session = sessions.find(s => s.id === id);
        if (session) {
            setActiveSessionId(id);
            setMessages(session.messages);
        }
    };

    return (
        <div className="flex flex-col h-full bg-neutral-50">
            <div className="p-4 border-b border-neutral-200 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <DependabotIcon />
                        <h3 className="font-bold text-md">AI Assistant</h3>
                    </div>
                    {messages.length > 0 && (
                        <button 
                            onClick={() => {
                                setMessages([]);
                                if (activeSessionId) {
                                    setSessions(prev => prev.filter(s => s.id !== activeSessionId));
                                    setActiveSessionId(null);
                                }
                            }} 
                            className="text-xs text-neutral-500 hover:text-red-500 font-medium"
                        >
                            Delete Chat
                        </button>
                    )}
                </div>
                <Select value={activeSessionId || "new"} onValueChange={(val) => val === "new" ? createNewSession() : switchSession(val)}>
                    <SelectTrigger className="h-8 text-xs font-semibold bg-white">
                        <SelectValue placeholder="Select a session" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="new" className="font-bold text-primary">+ New Chat Session</SelectItem>
                        {sessions.map(s => (
                            <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            
            <div ref={scrollContainerRef} className="flex-1 overflow-auto p-4 space-y-4">
                {messages.length === 0 && (
                    <div className="text-center text-sm text-neutral-500 mt-10">
                        Ask me anything about your database!
                    </div>
                )}
                {messages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`flex max-w-[90%] gap-2 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                            <div className="mt-1 flex-shrink-0 text-neutral-500">
                                {msg.role === "user" ? <PersonIcon /> : <DependabotIcon />}
                            </div>
                            <div className={`p-3 rounded-lg text-sm ${msg.role === "user" ? "bg-primary text-white" : "bg-white border border-neutral-200"}`}>
                                {msg.role === "ai" ? (
                                    msg.content.startsWith("Error:") ? (
                                        <p className="whitespace-pre-wrap">{msg.content}</p>
                                    ) : (
                                        (() => {
                                            const parts = msg.content.split(/```(\w*)\s*\n([\s\S]*?)```/gi);
                                            const renderedParts = [];
                                            for (let i = 0; i < parts.length; i++) {
                                                if (i % 3 === 0) {
                                                    if (parts[i].trim()) {
                                                        renderedParts.push(<p key={i} className="whitespace-pre-wrap mb-2">{parts[i].trim()}</p>);
                                                    }
                                                } else if (i % 3 === 2) {
                                                    const lang = parts[i - 1].toLowerCase();
                                                    const code = parts[i].trim();
                                                    // Only allow execution for single SQL select-like queries
                                                    const statements = code.split(';').map(s => s.trim()).filter(s => s.length > 0);
                                                    const isSingleStatement = statements.length === 1;
                                                    const isSelectQuery = (lang === "sql" || lang === "postgresql" || lang === "postgres") && !checkIsModifying(code) && isSingleStatement;

                                                    renderedParts.push(
                                                        <div key={i} className="my-2 p-2 bg-neutral-100 rounded border border-neutral-200">
                                                            {lang && <div className="text-xs text-neutral-400 mb-1 uppercase tracking-wider font-semibold">{lang}</div>}
                                                            <pre className="whitespace-pre-wrap font-mono text-xs mb-2 text-neutral-800">{code}</pre>
                                                            <div className="flex gap-2">
                                                                <CopyTextButton size="sm" variant="outline" text={code}>Copy Code</CopyTextButton>
                                                                {isSelectQuery && (
                                                                    <Button 
                                                                        size="sm" 
                                                                        variant="secondary" 
                                                                        icon={<PlayIcon />} 
                                                                        onClick={() => handleExecuteInternal(code)}
                                                                    >
                                                                        Use & Execute Query
                                                                    </Button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                }
                                            }
                                            return renderedParts;
                                        })()
                                    )
                                ) : msg.role === "system" ? (
                                    typeof msg.content === "string" ? (
                                        <p className="whitespace-pre-wrap text-neutral-500 text-xs font-mono">{msg.content}</p>
                                    ) : (
                                        <div className="overflow-x-auto">
                                            <Table className="text-xs">
                                                <TableHeader>
                                                    <TableRow>
                                                        {msg.content.columns.map((col: string) => (
                                                            <TableHead key={col}>{col}</TableHead>
                                                        ))}
                                                    </TableRow>
                                                </TableHeader>
                                                <TableBody>
                                                    {msg.content.rows.map((row: any, i: number) => (
                                                        <TableRow key={i}>
                                                            {msg.content.columns.map((col: string) => (
                                                                <TableCell key={col}>{String(row[col] ?? "")}</TableCell>
                                                            ))}
                                                        </TableRow>
                                                    ))}
                                                </TableBody>
                                            </Table>
                                            {msg.content.total > 10 && (
                                                <div className="text-xs text-neutral-500 mt-2 italic">Showing 10 of {msg.content.total} rows</div>
                                            )}
                                        </div>
                                    )
                                ) : (
                                    <p className="whitespace-pre-wrap">{msg.content}</p>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
                {loading && (
                    <div className="flex justify-start">
                        <div className="flex gap-2 text-neutral-500">
                            <DependabotIcon />
                            <div className="p-3 rounded-lg text-sm bg-white border border-neutral-200 animate-pulse">
                                Thinking...
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className="p-4 bg-white border-t border-neutral-200">
                <form onSubmit={handleSubmit} className="relative flex">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                handleSubmit(e as any);
                                return;
                            }
                            if (e.key === "ArrowUp") {
                                e.preventDefault();
                                if (history.length > 0) {
                                    const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
                                    setHistoryIndex(newIndex);
                                    setInput(history[history.length - 1 - newIndex]);
                                }
                            } else if (e.key === "ArrowDown") {
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
                        className="w-full font-mono resize-none min-h-[80px] p-3 pr-14 text-sm bg-neutral-50 border border-neutral-300 focus:outline-none focus:ring-1 focus:ring-primary/400"
                        placeholder="Ask anything about your database..."
                        disabled={loading}
                    />
                    <div className="absolute right-2 bottom-2">
                        <Button 
                            size="sm"
                            type="submit" 
                            disabled={loading || !input.trim()} 
                            icon={<ArrowRightIcon />} 
                            hasIconOnly 
                        />
                    </div>
                </form>
            </div>
        </div>
    );
};
