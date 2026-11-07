import { ActionFunction, LoaderFunction } from "@remix-run/node";
import { getSessionConnection, requireUser } from "~/utils/session.server";
import { userDb } from "~/utils/db.server";

/**
 * GET /api/queries?kind=history|saved&q=search&database=db
 * History and saved queries of the current connection, newest first
 */
export const loader: LoaderFunction = async ({ request }) => {
    const user = await requireUser(request, "/login");
    const connection = await getSessionConnection(request);
    if (!connection) {
        return Response.json({ message: "No connection selected" }, { status: 400 });
    }

    const url = new URL(request.url);
    const search = url.searchParams.get("q")?.trim();
    const database = url.searchParams.get("database")?.trim();
    const where = {
        userId: user.id,
        connectionId: connection.id,
        ...(database ? { database } : {}),
    };

    if (url.searchParams.get("kind") === "saved") {
        const saved = await userDb.savedQuery.findMany({
            where: { ...where, ...(search ? { OR: [{ name: { contains: search } }, { sql: { contains: search } }] } : {}) },
            orderBy: { updatedAt: "desc" },
            take: 200,
        });
        return Response.json({ saved });
    }

    const history = await userDb.queryHistory.findMany({
        where: { ...where, ...(search ? { sql: { contains: search } } : {}) },
        orderBy: { createdAt: "desc" },
        take: 100,
    });
    return Response.json({ history });
};

export const action: ActionFunction = async ({ request }) => {
    const user = await requireUser(request, "/login");
    const connection = await getSessionConnection(request);
    if (!connection) {
        return Response.json({ message: "No connection selected" }, { status: 400 });
    }
    const body = await request.json();
    const owned = { userId: user.id, connectionId: connection.id };

    switch (body.intent) {
        case "save": {
            const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
            const sql = typeof body.sql === "string" ? body.sql.trim() : "";
            if (!name || !sql) {
                return Response.json({ message: "A name and a query are required" }, { status: 400 });
            }
            // Saving under an existing name replaces that query
            const existing = await userDb.savedQuery.findFirst({ where: { ...owned, name } });
            const saved = existing
                ? await userDb.savedQuery.update({ where: { id: existing.id }, data: { sql, database: String(body.database || existing.database) } })
                : await userDb.savedQuery.create({ data: { ...owned, name, sql, database: String(body.database || "") } });
            return Response.json({ saved, replaced: !!existing });
        }
        case "delete_saved": {
            await userDb.savedQuery.deleteMany({ where: { ...owned, id: String(body.id) } });
            return Response.json({ ok: true });
        }
        case "delete_history": {
            await userDb.queryHistory.deleteMany({ where: { ...owned, id: String(body.id) } });
            return Response.json({ ok: true });
        }
        case "clear_history": {
            await userDb.queryHistory.deleteMany({ where: owned });
            return Response.json({ ok: true });
        }
        default:
            return Response.json({ message: "Invalid request" }, { status: 400 });
    }
};
