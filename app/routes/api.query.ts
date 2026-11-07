import { ActionFunction } from "@remix-run/node";
import { getSessionConnection, requireUser } from "~/utils/session.server";
import dbConnection from "~/lib/db";
import { runAndRecord } from "~/lib/queries.server";
import { runUserQuery, MAX_RESULT_ROWS } from "~/lib/run-query.server";

export const action: ActionFunction = async ({ request }) => {
    try {
        const user = await requireUser(request);
        if (!user) return Response.json({ message: "Unauthorized" }, { status: 401 });

        const body = await request.json();
        const { sql, db } = body;

        if (!sql || !db) {
            return Response.json({ message: "SQL and DB are required" }, { status: 400 });
        }

        const connection = await getSessionConnection(request);
        if (!connection) {
            return Response.json({ message: "No connection selected" }, { status: 400 });
        }
        const mongo = await dbConnection(connection);
        if (!mongo.isAllowed(db)) {
            return Response.json({ message: "Access to this database is not allowed" }, { status: 403 });
        }
        const pool = mongo.getPool(db);

        if (!pool) {
            return Response.json({ message: "Database connection failed" }, { status: 500 });
        }

        const res = await runAndRecord({ userId: user.id, connectionId: connection.id, database: db, sql }, () => runUserQuery(pool, sql));

        return Response.json({
            columns: res.fields.map((f) => f.name),
            rows: res.rows,
            rowCount: res.rowCount,
            command: res.command,
            // Only the first MAX_RESULT_ROWS rows are sent, the export buttons get all of them
            truncated: res.truncated,
            maxRows: MAX_RESULT_ROWS,
        });

    } catch (e: any) {
        return Response.json({ message: e.message }, { status: 500 });
    }
};
