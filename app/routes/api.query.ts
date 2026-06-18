import { ActionFunction } from "@remix-run/node";
import { requireUser } from "~/utils/session.server";
import { userDb } from "~/utils/db.server";
import dbConnection from "~/lib/db";

export const action: ActionFunction = async ({ request }) => {
    try {
        const user = await requireUser(request);
        if (!user) return Response.json({ message: "Unauthorized" }, { status: 401 });

        const body = await request.json();
        const { sql, db } = body;

        if (!sql || !db) {
            return Response.json({ message: "SQL and DB are required" }, { status: 400 });
        }

        const session = await (await import("~/utils/session.server")).getUserSession(request);
        const connection = session.get("connection");
        if (!connection) {
            return Response.json({ message: "No connection selected" }, { status: 400 });
        }
        const mongo = await dbConnection(connection);
        const pool = mongo.getPool(db);

        if (!pool) {
            return Response.json({ message: "Database connection failed" }, { status: 500 });
        }

        const res = await pool.query(sql);

        return Response.json({ 
            columns: res.fields ? res.fields.map((f: any) => f.name) : [], 
            rows: res.rows || [],
            rowCount: res.rowCount
        });

    } catch (e: any) {
        return Response.json({ message: e.message }, { status: 500 });
    }
};
