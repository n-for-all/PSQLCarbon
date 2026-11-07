import { ActionFunction } from "@remix-run/node";
import { getSessionConnection, requireUser } from "~/utils/session.server";
import dbConnection from "~/lib/db";
import { exportQuery, type ExportFormat } from "~/lib/export.server";

/**
 * POST { db, sql, format: "csv" | "json" }, downloads every row of a query
 */
export const action: ActionFunction = async ({ request }) => {
    try {
        await requireUser(request, "/login");
        const connection = await getSessionConnection(request);
        if (!connection) return Response.json({ message: "No connection selected" }, { status: 400 });
        const body = await request.json();
        const format: ExportFormat = body.format === "json" ? "json" : "csv";
        if (typeof body.sql !== "string" || !body.sql.trim()) return Response.json({ message: "The query is empty" }, { status: 400 });

        const mongo = await dbConnection(connection);
        if (typeof body.db !== "string" || !mongo.isAllowed(body.db)) return Response.json({ message: "Access to this database is not allowed" }, { status: 403 });
        const pool = mongo.getPool(body.db);
        if (!pool) return Response.json({ message: "Could not connect to the database" }, { status: 500 });

        const rows = exportQuery(pool, body.sql, format);
        // Run up to the first chunk so query errors come back as a normal error response
        const first = await rows.next();
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                if (!first.done) controller.enqueue(encoder.encode(first.value));
                if (first.done) controller.close();
            },
            async pull(controller) {
                try {
                    const { value, done } = await rows.next();
                    if (done) controller.close();
                    else controller.enqueue(encoder.encode(value));
                } catch (error) {
                    controller.error(error);
                }
            },
            async cancel() {
                await rows.return(undefined);
            },
        });

        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
        const fileName = `${body.db}_query_${stamp}.${format}`.replace(/[^\w.-]/g, "_");
        return new Response(stream, {
            headers: {
                "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="${fileName}"`,
                "Cache-Control": "no-store, no-transform",
            },
        });
    } catch (e: any) {
        if (e instanceof Response) return e;
        return Response.json({ message: e.message }, { status: 400 });
    }
};
