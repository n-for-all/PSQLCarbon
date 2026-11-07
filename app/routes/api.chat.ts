import { ActionFunction, LoaderFunction } from "@remix-run/node";
import { getSessionConnection, requireUser } from "~/utils/session.server";
import { userDb } from "~/utils/db.server";
import dbConnection from "~/lib/db";
import { AI_NOT_CONFIGURED, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, isAiConfigured } from "~/utils/ai";
import { runAgent, unansweredToolCalls, type AgentEvent, type ChatMessage } from "~/lib/ai/agent.server";
import { WRITE_MODES, type WriteMode } from "~/lib/ai/tools.server";

const parseMessages = (messages: string): ChatMessage[] => {
    try {
        const parsed = JSON.parse(messages);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

/**
 * GET /api/chat?database=db       sessions, memories and settings for the current connection
 * GET /api/chat?session=id        one session with its messages
 */
export const loader: LoaderFunction = async ({ request }) => {
    const user = await requireUser(request, "/login");
    const connection = await getSessionConnection(request);
    if (!connection) {
        return Response.json({ message: "No connection selected" }, { status: 400 });
    }

    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session");
    if (sessionId) {
        const session = await userDb.chatSession.findFirst({ where: { id: sessionId, userId: user.id, connectionId: connection.id } });
        if (!session) {
            return Response.json({ message: "Chat not found" }, { status: 404 });
        }
        return Response.json({ session: { ...session, messages: parseMessages(session.messages) } });
    }

    const database = url.searchParams.get("database");
    const [sessions, memories, settings] = await Promise.all([
        userDb.chatSession.findMany({
            where: { userId: user.id, connectionId: connection.id },
            select: { id: true, title: true, database: true, updatedAt: true },
            orderBy: { updatedAt: "desc" },
            take: 100,
        }),
        database
            ? userDb.chatMemory.findMany({ where: { userId: user.id, connectionId: connection.id, database }, orderBy: { createdAt: "asc" } })
            : Promise.resolve([]),
        userDb.user.findUnique({ where: { id: user.id }, select: { aiWriteMode: true, openAiModel: true, openAiApiKey: true, openAiBaseUrl: true } }),
    ]);

    return Response.json({
        sessions,
        memories,
        settings: { writeMode: settings?.aiWriteMode || "ask", model: settings?.openAiModel || DEFAULT_AI_MODEL, configured: isAiConfigured(settings) },
    });
};

export const action: ActionFunction = async ({ request }) => {
    try {
        const user = await requireUser(request, "/login");
        const connection = await getSessionConnection(request);
        if (!connection) {
            return Response.json({ message: "No connection selected" }, { status: 400 });
        }
        const body = await request.json();

        switch (body.intent) {
            case "settings": {
                if (!WRITE_MODES.includes(body.writeMode)) {
                    return Response.json({ message: "Invalid mode" }, { status: 400 });
                }
                await userDb.user.update({ where: { id: user.id }, data: { aiWriteMode: body.writeMode } });
                return Response.json({ ok: true });
            }
            case "delete_session": {
                await userDb.chatSession.deleteMany({ where: { id: String(body.sessionId), userId: user.id } });
                return Response.json({ ok: true });
            }
            case "delete_memory": {
                await userDb.chatMemory.deleteMany({ where: { id: String(body.memoryId), userId: user.id } });
                return Response.json({ ok: true });
            }
            case "send":
            case "resume":
                return await runChat(request, user.id, connection, body);
            default:
                return Response.json({ message: "Invalid request" }, { status: 400 });
        }
    } catch (e: any) {
        if (e instanceof Response) {
            return e;
        }
        console.error("Chat Error:", e);
        return Response.json({ message: e.message }, { status: 500 });
    }
};

async function runChat(request: Request, userId: string, connection: NonNullable<Awaited<ReturnType<typeof getSessionConnection>>>, body: any) {
    const dbUser = await userDb.user.findUnique({ where: { id: userId } });
    if (!dbUser || !isAiConfigured(dbUser)) {
        return Response.json({ message: AI_NOT_CONFIGURED }, { status: 400 });
    }

    // Load or create the chat, a chat stays on the database it was started on
    let session = body.sessionId ? await userDb.chatSession.findFirst({ where: { id: String(body.sessionId), userId, connectionId: connection.id } }) : null;
    if (body.sessionId && !session) {
        return Response.json({ message: "Chat not found" }, { status: 404 });
    }

    const mongo = await dbConnection(connection);
    const database = session?.database || (typeof body.database === "string" && body.database) || mongo.defaultDb;
    if (!mongo.isAllowed(database)) {
        return Response.json({ message: "Access to this database is not allowed" }, { status: 403 });
    }
    const pool = mongo.getPool(database);
    if (!pool) {
        return Response.json({ message: "Database connection failed" }, { status: 500 });
    }

    const messages = session ? parseMessages(session.messages) : [];
    if (body.intent === "send") {
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) {
            return Response.json({ message: "Message is empty" }, { status: 400 });
        }
        // A new message replaces any change still waiting for approval
        for (const call of unansweredToolCalls(messages)) {
            messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify({ error: "Not run, the user sent a new message instead" }),
                display: { tool: call.function.name, skipped: true },
            });
        }
        messages.push({ role: "user", content: prompt, createdAt: Date.now() });
    }

    if (!session) {
        const prompt = String(body.prompt);
        session = await userDb.chatSession.create({
            data: { title: prompt.length > 60 ? prompt.slice(0, 60) + "…" : prompt, database, connectionId: connection.id, userId, messages: JSON.stringify(messages) },
        });
    } else {
        await userDb.chatSession.update({ where: { id: session.id }, data: { messages: JSON.stringify(messages) } });
    }
    const sessionId = session.id;

    const rawBaseUrl = dbUser.openAiBaseUrl || DEFAULT_AI_BASE_URL;
    const reqUrl = new URL(request.url);
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const emit = (event: AgentEvent | { type: string; [key: string]: unknown }) => {
                try {
                    controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
                } catch {
                    // the client went away, the chat is still saved
                }
            };
            emit({ type: "session", session: { id: sessionId, title: session!.title, database } });

            try {
                await runAgent({
                    messages,
                    database,
                    resolvePool: (name?: string) => {
                        const target = name || database;
                        if (!mongo.isAllowed(target)) {
                            throw new Error(`Access to the database "${target}" is not allowed on this connection`);
                        }
                        const targetPool = name ? mongo.getPool(target) : pool;
                        if (!targetPool) {
                            throw new Error(`Could not connect to the database "${target}"`);
                        }
                        return { pool: targetPool, database: target };
                    },
                    listDatabases: () => mongo.getDatabases(),
                    table: typeof body.table === "string" ? body.table : null,
                    writeMode: (WRITE_MODES.includes(dbUser.aiWriteMode as WriteMode) ? dbUser.aiWriteMode : "ask") as WriteMode,
                    userId,
                    connectionId: connection.id,
                    memories: await userDb.chatMemory.findMany({ where: { userId, connectionId: connection.id, database }, select: { id: true, content: true }, orderBy: { createdAt: "asc" } }),
                    api: {
                        baseUrl: rawBaseUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, ""),
                        apiKey: dbUser.openAiApiKey || "",
                        model: dbUser.openAiModel || DEFAULT_AI_MODEL,
                        referer: reqUrl.origin && reqUrl.origin !== "null" ? reqUrl.origin : "http://localhost:5173",
                    },
                    approvals: body.intent === "resume" && body.toolCallId ? { [String(body.toolCallId)]: body.approved === true } : undefined,
                    signal: request.signal,
                    emit,
                    save: async (current) => {
                        await userDb.chatSession.update({ where: { id: sessionId }, data: { messages: JSON.stringify(current) } });
                    },
                });
            } catch (e: any) {
                if (e?.name !== "AbortError") {
                    console.error("Chat Error:", e);
                    emit({ type: "error", message: e?.message || String(e) });
                }
            } finally {
                emit({ type: "done" });
                try {
                    controller.close();
                } catch {
                    // already closed
                }
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            // no-transform keeps compression middleware from buffering the stream
            "Cache-Control": "no-store, no-transform",
            "X-Accel-Buffering": "no",
        },
    });
}
