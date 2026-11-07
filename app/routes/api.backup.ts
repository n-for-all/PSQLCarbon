import { ActionFunction, LoaderFunction } from "@remix-run/node";
import { getSessionConnection, requireUser } from "~/utils/session.server";
import dbConnection from "~/lib/db";
import { builtinDump, findPgTool, pgDumpStream, serverVersion, type BackupContent } from "~/lib/backup.server";
import { detectFormat, restoreArchive, restoreSql, type RestoreEvent } from "~/lib/restore.server";

const CONTENTS: BackupContent[] = ["all", "schema", "data"];

const loadDatabase = async (request: Request, database: string | null) => {
    await requireUser(request, "/login");
    const connection = await getSessionConnection(request);
    if (!connection) throw Response.json({ message: "No connection selected" }, { status: 400 });
    if (!database) throw Response.json({ message: "No database given" }, { status: 400 });
    const mongo = await dbConnection(connection);
    if (!mongo.isAllowed(database)) throw Response.json({ message: "Access to this database is not allowed" }, { status: 403 });
    const pool = mongo.getPool(database);
    if (!pool) throw Response.json({ message: "Could not connect to the database" }, { status: 500 });
    return { connection, mongo, pool };
};

const timestamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);

/**
 * GET /api/backup?db=name&content=all|schema|data&engine=auto|builtin|pg_dump&format=plain|custom&gzip=1
 * Downloads a backup, pg_dump is used when available and new enough, otherwise the built-in engine
 */
export const loader: LoaderFunction = async ({ request }) => {
    try {
        const url = new URL(request.url);
        const database = url.searchParams.get("db");
        const { connection, pool } = await loadDatabase(request, database);
        const content = (CONTENTS.includes(url.searchParams.get("content") as BackupContent) ? url.searchParams.get("content") : "all") as BackupContent;
        const engine = url.searchParams.get("engine") || "auto";
        const format = url.searchParams.get("format") === "custom" ? "custom" : "plain";
        const gzip = url.searchParams.get("gzip") === "1" && format === "plain";

        let usePgDump = false;
        const tool = engine === "builtin" ? null : await findPgTool("pg_dump");
        if (engine !== "builtin" && tool) {
            const server = await serverVersion(pool);
            usePgDump = tool.major >= server.major;
            if (engine === "pg_dump" && !usePgDump) {
                return Response.json({ message: `pg_dump ${tool.version} is older than the server (PostgreSQL ${server.version}) and can't back it up` }, { status: 400 });
            }
        } else if (engine === "pg_dump") {
            return Response.json({ message: "pg_dump isn't available on this server" }, { status: 400 });
        }
        if (format === "custom" && !usePgDump) {
            return Response.json({ message: "The custom (.dump) format needs pg_dump, use plain SQL instead" }, { status: 400 });
        }

        let body: ReadableStream<Uint8Array>;
        if (usePgDump) {
            body = await pgDumpStream(tool!, connection, database!, { content, format });
        } else {
            const chunks = builtinDump(pool, database!, content);
            const encoder = new TextEncoder();
            body = new ReadableStream({
                async pull(controller) {
                    try {
                        const { value, done } = await chunks.next();
                        if (done) controller.close();
                        else controller.enqueue(encoder.encode(value));
                    } catch (error: any) {
                        // The download has started, the marker lets the page tell a broken backup apart
                        controller.enqueue(encoder.encode(`\n-- BACKUP FAILED: ${error.message}\n`));
                        controller.error(error);
                    }
                },
                async cancel() {
                    await chunks.return(undefined);
                },
            });
        }
        if (gzip) body = body.pipeThrough(new CompressionStream("gzip") as any);

        const extension = format === "custom" ? "dump" : gzip ? "sql.gz" : "sql";
        const fileName = `${database}_${content === "all" ? "" : content + "_"}${timestamp()}.${extension}`;
        return new Response(body, {
            headers: {
                "Content-Type": format === "custom" || gzip ? "application/octet-stream" : "application/sql; charset=utf-8",
                "Content-Disposition": `attachment; filename="${fileName.replace(/[^\w.-]/g, "_")}"`,
                "Cache-Control": "no-store, no-transform",
                "X-Backup-Engine": usePgDump ? `pg_dump ${tool!.version}` : "built-in",
            },
        });
    } catch (e: any) {
        if (e instanceof Response) return e;
        return Response.json({ message: e.message }, { status: 500 });
    }
};

/**
 * POST /api/backup?db=name&target=existing|new&newName=x&singleTransaction=1&skipOwnership=1 with the backup file as the body.
 * Streams restore progress as NDJSON.
 */
export const action: ActionFunction = async ({ request }) => {
    try {
        const url = new URL(request.url);
        const { connection, mongo, pool } = await loadDatabase(request, url.searchParams.get("db"));
        if (!request.body) return Response.json({ message: "No file uploaded" }, { status: 400 });

        let targetDatabase = url.searchParams.get("db")!;
        let targetPool = pool;
        if (url.searchParams.get("target") === "new") {
            const name = (url.searchParams.get("newName") || "").trim();
            if (!/^[A-Za-z0-9_][A-Za-z0-9_\-$]{0,62}$/.test(name)) {
                return Response.json({ message: "Use a database name of letters, numbers, _ and - (up to 63 characters)" }, { status: 400 });
            }
            if (!mongo.isAllowed(name)) return Response.json({ message: `"${name}" isn't allowed by this connection's whitelist/blacklist` }, { status: 403 });
            try {
                await pool.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
            } catch (error: any) {
                return Response.json({ message: `Could not create the database: ${error.message}` }, { status: 400 });
            }
            targetDatabase = name;
            targetPool = mongo.getPool(name)!;
        }

        const options = {
            singleTransaction: url.searchParams.get("singleTransaction") !== "0",
            skipOwnership: url.searchParams.get("skipOwnership") !== "0",
            totalBytes: Number(request.headers.get("content-length")) || null,
            signal: request.signal,
        };
        const { format, stream, gzip } = await detectFormat(request.body);
        const restoreTool = format === "archive" ? await findPgTool("pg_restore") : null;
        if (format === "archive" && !restoreTool) {
            return Response.json(
                { message: "This is a pg_dump archive (.dump). Restoring it needs pg_restore, which isn't available on this server. Make a plain SQL backup instead, it restores anywhere." },
                { status: 400 }
            );
        }

        const encoder = new TextEncoder();
        const body = new ReadableStream({
            async start(controller) {
                const emit = (event: RestoreEvent) => {
                    try {
                        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
                    } catch {
                        // the page went away
                    }
                };
                emit({
                    type: "log",
                    message: `Restoring a ${format === "archive" ? "pg_dump archive with pg_restore " + restoreTool!.version : `${gzip ? "gzipped " : ""}SQL file`} into "${targetDatabase}"`,
                });
                try {
                    if (format === "archive") await restoreArchive(restoreTool!, connection, targetDatabase, stream, options, emit);
                    else await restoreSql(targetPool, stream, options, emit);
                } catch (error: any) {
                    emit({ type: "done", ok: false, statements: 0, rows: 0, durationMs: 0, message: error.message });
                }
                controller.close();
            },
        });
        return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform" } });
    } catch (e: any) {
        if (e instanceof Response) return e;
        return Response.json({ message: e.message }, { status: 500 });
    }
};
