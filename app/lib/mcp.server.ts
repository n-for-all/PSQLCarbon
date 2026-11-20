// MCP server of the desktop app (the downloadable build only, the Mac App Store build can't accept connections).
// Claude Code, Cursor and other MCP clients connect to http://127.0.0.1:<port>/mcp with a token, Claude Desktop
// through electron/mcp-bridge.cjs. They get the saved connections and the assistant's database tools.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import packageJson from "../../package.json";
import connect from "~/lib/db";
import { userDb } from "~/utils/db.server";
import { executeTool, NEEDS_APPROVAL, WRITE_MODES, type WriteMode } from "~/lib/ai/tools.server";

export type McpSettings = { enabled: boolean; token: string; port: number; writeMode: WriteMode };

const DEFAULT_PORT = 47815;
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1_000_000;

/** Only the downloadable desktop app: the App Store sandbox doesn't allow incoming connections */
export const mcpAvailable = () => process.env.PSQLCARBON_DESKTOP === "1" && process.env.PSQLCARBON_APP_STORE !== "1" && !!process.env.PSQLCARBON_DATA_DIR;

const settingsFile = () => path.join(process.env.PSQLCARBON_DATA_DIR || ".", "mcp.json");

export function readMcpSettings(): McpSettings {
    let saved: Partial<McpSettings> = {};
    try {
        saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    } catch {
        // not set up yet
    }
    return {
        enabled: saved.enabled === true,
        token: typeof saved.token === "string" && saved.token.length >= 32 ? saved.token : crypto.randomBytes(24).toString("hex"),
        port: Number.isInteger(saved.port) ? (saved.port as number) : DEFAULT_PORT,
        writeMode: WRITE_MODES.includes(saved.writeMode as WriteMode) ? (saved.writeMode as WriteMode) : "read_only",
    };
}

function writeMcpSettings(settings: McpSettings) {
    // The token is a password for the databases, only the user may read it
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

declare global {
    var __psqlcarbonMcp: { server: http.Server; port: number } | undefined;
    // electron/main.js: asks the user to approve a change, resolves true when they do
    var __psqlcarbonConfirmMcp: ((request: { client: string; connection: string; database: string; sql: string }) => Promise<boolean>) | undefined;
}

export const mcpStatus = () => ({ running: !!global.__psqlcarbonMcp, port: global.__psqlcarbonMcp?.port ?? null });

/**
 * Saves the settings and starts or stops the server to match
 */
export async function updateMcpSettings(changes: { enabled?: boolean; writeMode?: WriteMode; regenerateToken?: boolean }) {
    const settings = readMcpSettings();
    if (typeof changes.enabled === "boolean") settings.enabled = changes.enabled;
    if (changes.writeMode && WRITE_MODES.includes(changes.writeMode)) settings.writeMode = changes.writeMode;
    if (changes.regenerateToken) settings.token = crypto.randomBytes(24).toString("hex");
    writeMcpSettings(settings);
    await stopMcpServer();
    await ensureMcpServer();
    return readMcpSettings();
}

/**
 * Starts the server when it's turned on, called when the app starts (app/root.tsx) and after a settings change
 */
export async function ensureMcpServer() {
    if (!mcpAvailable() || global.__psqlcarbonMcp) return;
    const settings = readMcpSettings();
    if (!settings.enabled) return;
    // The same port as last time keeps the clients' configuration working, the next free one otherwise
    for (let port = settings.port; port < settings.port + 20; port++) {
        const server = http.createServer((req, res) => {
            handle(req, res).catch((error) => {
                if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error?.message || "Internal error" } }));
            });
        });
        const listening = await new Promise<boolean>((resolve) => {
            server.once("error", () => resolve(false));
            server.listen(port, "127.0.0.1", () => resolve(true));
        });
        if (listening) {
            global.__psqlcarbonMcp = { server, port };
            if (port !== settings.port) writeMcpSettings({ ...settings, port });
            return;
        }
    }
    console.error("The MCP server found no free port");
}

async function stopMcpServer() {
    const running = global.__psqlcarbonMcp;
    if (!running) return;
    global.__psqlcarbonMcp = undefined;
    running.server.closeAllConnections?.();
    await new Promise((resolve) => running.server.close(resolve));
}

const json = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
};

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp") return json(res, 404, { error: "Not found" });

    // Web pages can't use it: they'd send an Origin, and a rebound DNS name wouldn't match the host
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost"].includes(host)) return json(res, 403, { error: "Forbidden" });
    if (req.headers.origin) return json(res, 403, { error: "Forbidden" });

    const settings = readMcpSettings();
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const expected = Buffer.from(settings.token);
    const given = Buffer.from(token);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return json(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Invalid token, copy the configuration again from PSQLCarbon's settings" } });
    }

    // Stateless: no server initiated messages, so there is no event stream to open or session to end
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return json(res, 405, { error: "Method not allowed" });
    }

    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return json(res, 413, { error: "Request too large" });
        chunks.push(chunk);
    }
    let body: any;
    try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }

    const client = String(req.headers["user-agent"] || "MCP client").split(/[\s/]/)[0];
    const messages = Array.isArray(body) ? body : [body];
    const responses = (await Promise.all(messages.map((message) => answer(message, settings, client)))).filter(Boolean);
    if (!responses.length) return json(res, 202);
    return json(res, 200, Array.isArray(body) ? responses : responses[0]);
}

async function answer(message: any, settings: McpSettings, client: string) {
    // Notifications and responses get no answer
    if (!message || typeof message !== "object" || message.id === undefined || message.id === null || typeof message.method !== "string") return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
    const error = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });

    switch (message.method) {
        case "initialize": {
            const requested = message.params?.protocolVersion;
            return reply({
                protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
                capabilities: { tools: {} },
                serverInfo: { name: "psqlcarbon", title: "PSQLCarbon", version: packageJson.version },
                instructions:
                    "PostgreSQL databases saved in PSQLCarbon. Start with list_connections, then list_databases / list_tables / describe_table, and run_query to read data. " +
                    (settings.writeMode === "read_only"
                        ? "Changes are turned off: only read queries run."
                        : settings.writeMode === "ask"
                          ? "Statements that change data or schema are shown to the user in PSQLCarbon to approve first."
                          : "Statements that change data or schema run immediately, check what they affect first."),
            });
        }
        case "ping":
            return reply({});
        case "tools/list":
            return reply({ tools: TOOLS });
        case "tools/call": {
            const name = message.params?.name;
            if (!TOOLS.some((tool) => tool.name === name)) return error(-32602, `Unknown tool: ${name}`);
            try {
                const text = await callTool(name, message.params?.arguments || {}, settings, client);
                let isError = false;
                try {
                    isError = !!JSON.parse(text)?.error;
                } catch {
                    // plain text
                }
                return reply({ content: [{ type: "text", text }], isError });
            } catch (e: any) {
                return reply({ content: [{ type: "text", text: JSON.stringify({ error: e?.message || String(e) }) }], isError: true });
            }
        }
        default:
            return error(-32601, `Method not found: ${message.method}`);
    }
}

const connectionArg = {
    connection: { type: "string", description: "Name (or id) of a saved connection, see list_connections. Can be left out when there is only one" },
};
const databaseArg = {
    database: { type: "string", description: "Database on the connection, the connection's own database when left out. See list_databases" },
};

const TOOLS = [
    {
        name: "list_connections",
        title: "List connections",
        description: "List the PostgreSQL connections saved in PSQLCarbon, with the database each one logs into. Credentials are never shown.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
    },
    {
        name: "list_databases",
        title: "List databases",
        description: "List the databases on a connection's server that it may use. A query only sees one database.",
        inputSchema: { type: "object", properties: { ...connectionArg } },
        annotations: { readOnlyHint: true },
    },
    {
        name: "list_tables",
        title: "List tables",
        description: "List the tables, views and materialized views in a database with their schema, estimated row counts and sizes.",
        inputSchema: { type: "object", properties: { ...connectionArg, ...databaseArg, schema: { type: "string", description: "Only this schema, all schemas when left out" } } },
        annotations: { readOnlyHint: true },
    },
    {
        name: "describe_table",
        title: "Describe table",
        description: "Columns, types, defaults, constraints (primary and foreign keys), indexes, estimated row count and a few sample rows of a table or view.",
        inputSchema: {
            type: "object",
            properties: {
                ...connectionArg,
                ...databaseArg,
                schema: { type: "string", description: "Schema of the table, the one selected in PSQLCarbon (usually public) when left out" },
                table: { type: "string", description: "Table or view name, exactly as stored (case sensitive)" },
            },
            required: ["table"],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "run_query",
        title: "Run SQL",
        description:
            "Run SQL on a database and get the results (capped). Reads run in a read only transaction, one statement per call. Statements that change data or schema follow PSQLCarbon's MCP setting: refused (read only), approved by the user in the app, or run directly.",
        inputSchema: { type: "object", properties: { ...connectionArg, ...databaseArg, sql: { type: "string", description: "The SQL to run" } }, required: ["sql"] },
        annotations: { readOnlyHint: false, destructiveHint: true },
    },
];

async function localUser() {
    const user = await userDb.user.findFirst({ orderBy: { createdAt: "asc" } });
    if (!user) throw new Error("Open PSQLCarbon once to set it up");
    return user;
}

async function callTool(name: string, args: any, settings: McpSettings, client: string): Promise<string> {
    const user = await localUser();
    const saved = await userDb.dbConnection.findMany({ where: { userId: user.id }, orderBy: { name: "asc" } });

    if (name === "list_connections") {
        return JSON.stringify({
            connections: saved.map((connection) => {
                let database = "postgres";
                try {
                    database = new URL(connection.connectionString).pathname.replace(/^\//, "") || "postgres";
                } catch {}
                return { name: connection.name, id: connection.id, database };
            }),
        });
    }

    const wanted = typeof args.connection === "string" ? args.connection.trim() : "";
    const connection = wanted ? saved.find((c) => c.id === wanted) || saved.find((c) => c.name === wanted) || saved.find((c) => c.name.toLowerCase() === wanted.toLowerCase()) : saved.length === 1 ? saved[0] : undefined;
    if (!connection) {
        throw new Error(
            saved.length
                ? `${wanted ? `No connection named "${wanted}". ` : "Name the connection. "}Saved connections: ${saved.map((c) => `"${c.name}"`).join(", ")}`
                : "No connections are saved in PSQLCarbon yet"
        );
    }

    const mongo = await connect(connection);
    const database = typeof args.database === "string" && args.database ? args.database : mongo.defaultDb;
    const ctx = {
        database,
        resolvePool: (target?: string) => {
            const dbName = target || database;
            if (!mongo.isAllowed(dbName)) throw new Error(`Access to the database "${dbName}" is not allowed on this connection`);
            const pool = mongo.getPool(dbName);
            if (!pool) throw new Error(`Could not connect to the database "${dbName}"`);
            return { pool, database: dbName };
        },
        listDatabases: () => mongo.getDatabases(),
        writeMode: settings.writeMode,
        userId: user.id,
        connectionId: connection.id,
    };
    const toolArgs = { ...args, database };

    let outcome = await executeTool(name, toolArgs, ctx);
    if (outcome === NEEDS_APPROVAL) {
        const confirm = global.__psqlcarbonConfirmMcp;
        const approved = confirm ? await confirm({ client, connection: connection.name, database, sql: String(args.sql || "") }) : false;
        outcome = await executeTool(name, toolArgs, { ...ctx, approved });
    }
    if (outcome === NEEDS_APPROVAL) throw new Error("The change was not approved");
    return outcome.content;
}
