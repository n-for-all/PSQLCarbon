import { useState } from "react";
import { CheckIcon, CopyIcon, SyncIcon } from "@primer/octicons-react";
import { Switch } from "~/ui/switch";
import { toast } from "~/ui/hooks/use-toast";

export type McpInfo = {
    available: boolean;
    enabled?: boolean;
    running?: boolean;
    writeMode?: "read_only" | "ask" | "auto";
    url?: string;
    token?: string;
    bridge?: { command: string; args: string[]; env: Record<string, string> } | null;
};

const WRITE_MODES = [
    { value: "read_only", label: "Read only", hint: "Only read queries run, changes are refused" },
    { value: "ask", label: "Ask before changes", hint: "PSQLCarbon shows each change to approve first" },
    { value: "auto", label: "Allow changes", hint: "Changes run without asking" },
] as const;

const Snippet = ({ title, hint, text }: { title: string; hint?: string; text: string }) => {
    const [copied, setCopied] = useState(false);
    return (
        <div className="min-w-0">
            <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium">{title}</span>
                <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900"
                    onClick={async () => {
                        await navigator.clipboard.writeText(text);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    }}>
                    {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />} {copied ? "Copied" : "Copy"}
                </button>
            </div>
            {hint && <p className="mb-1 text-xs text-neutral-500">{hint}</p>}
            {/* Wrapped so the dialog never scrolls sideways, Copy takes the exact text */}
            <pre className="p-2 text-[11px] leading-snug border rounded bg-neutral-50 border-neutral-200 whitespace-pre-wrap break-all max-h-56 overflow-y-auto">{text}</pre>
        </div>
    );
};

/**
 * Turns the MCP server on or off and shows how to add it to Claude Code, Claude Desktop, Cursor and others
 * (app/lib/mcp.server.ts)
 */
export const McpSettings = ({ info, onChange }: { info: McpInfo; onChange: (info: McpInfo) => void }) => {
    const [saving, setSaving] = useState(false);

    const update = async (changes: Record<string, unknown>) => {
        setSaving(true);
        try {
            const response = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message);
            onChange(data);
            if (changes.enabled === true && !data.running) toast({ title: "The MCP server could not start", type: "background" });
        } catch (error: any) {
            toast({ title: "Error", description: error.message, type: "background" });
        } finally {
            setSaving(false);
        }
    };

    const auth = `Bearer ${info.token}`;
    const claudeCode = `claude mcp add --transport http psqlcarbon ${info.url} --header "Authorization: ${auth}"`;
    const claudeDesktop = JSON.stringify({ mcpServers: { psqlcarbon: info.bridge } }, null, 2);
    const httpClients = JSON.stringify({ mcpServers: { psqlcarbon: { url: info.url, headers: { Authorization: auth } } } }, null, 2);

    return (
        <div className="flex flex-col min-w-0 gap-5">
            <label className="flex items-start gap-3">
                <Switch checked={!!info.enabled} disabled={saving} onCheckedChange={(enabled) => update({ enabled })} className="mt-0.5" />
                <span className="min-w-0">
                    <span className="block text-sm font-medium">MCP server</span>
                    <span className="block text-xs text-neutral-500">
                        Lets AI apps on this Mac (Claude Code, Claude Desktop, Cursor ...) use your saved connections. It only accepts connections from this Mac, with the token below, while
                        PSQLCarbon is open.
                    </span>
                    {info.enabled && (
                        <span className={`block mt-1 text-xs ${info.running ? "text-green-700" : "text-red-600"}`}>{info.running ? `Running on ${info.url}` : "Not running, turn it off and on again"}</span>
                    )}
                </span>
            </label>

            {info.enabled && (
                <>
                    <div>
                        <span className="block mb-1.5 text-sm font-medium">Changes from AI apps</span>
                        <div className="flex flex-col gap-1.5">
                            {WRITE_MODES.map((mode) => (
                                <label key={mode.value} className="flex flex-wrap items-center gap-x-2 text-sm cursor-pointer">
                                    <input type="radio" name="mcpWriteMode" checked={info.writeMode === mode.value} disabled={saving} onChange={() => update({ writeMode: mode.value })} />
                                    <span>{mode.label}</span>
                                    <span className="text-xs text-neutral-500">{mode.hint}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <Snippet title="Claude Code" hint="Run in a terminal" text={claudeCode} />
                    {info.bridge && (
                        <Snippet
                            title="Claude Desktop"
                            hint="Settings > Developer > Edit Config, add this to claude_desktop_config.json and restart Claude. It opens PSQLCarbon when needed."
                            text={claudeDesktop}
                        />
                    )}
                    <Snippet title="Cursor, VS Code and other apps" hint="Their MCP configuration with a URL and headers" text={httpClients} />

                    <button
                        type="button"
                        disabled={saving}
                        onClick={() => update({ regenerateToken: true })}
                        className="flex items-center self-start gap-1 text-xs underline text-neutral-500 hover:text-red-600">
                        <SyncIcon size={12} /> New token (apps using the current one stop working until you update them)
                    </button>
                </>
            )}
        </div>
    );
};
