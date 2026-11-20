import { ActionFunction } from "@remix-run/node";
import { getSessionConnection, requireUser, setSessionSchema } from "~/utils/session.server";
import dbConnection from "~/lib/db";

/**
 * POST { db, schema }: the schema the sidebar, the tables, the query editor and the assistant use for a database.
 * It's kept in the session, app/lib/db.ts applies it to the database's connections.
 */
export const action: ActionFunction = async ({ request }) => {
    try {
        await requireUser(request, "/login");
        const connection = await getSessionConnection(request);
        if (!connection) return Response.json({ message: "No connection selected" }, { status: 400 });
        const body = await request.json();
        if (typeof body.db !== "string" || typeof body.schema !== "string" || !body.schema) return Response.json({ message: "Choose a schema" }, { status: 400 });

        const mongo = await dbConnection(connection);
        if (!mongo.isAllowed(body.db)) return Response.json({ message: "Access to this database is not allowed" }, { status: 403 });
        const { schemas } = await mongo.getSchemaTables(body.db);
        if (!schemas.some((schema) => schema.name === body.schema)) return Response.json({ message: `"${body.schema}" has no tables you can read` }, { status: 400 });

        const cookie = await setSessionSchema(request, connection.id, body.db, body.schema);
        await mongo.applySchemas({ ...connection.schemas, [body.db]: body.schema });
        return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
    } catch (error: any) {
        return Response.json({ message: error?.message || "Could not change the schema" }, { status: 500 });
    }
};
