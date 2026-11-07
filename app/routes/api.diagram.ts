import { ActionFunction } from "@remix-run/node";
import { getSessionConnection, requireUser } from "~/utils/session.server";
import { userDb } from "~/utils/db.server";
import dbConnection from "~/lib/db";
import { loadDiagramSchema } from "~/lib/schema-diagram.server";
import { inferByName, inferWithAi, verifyRelations } from "~/lib/relations.server";
import { AI_NOT_CONFIGURED, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, isAiConfigured } from "~/utils/ai";

/**
 * POST { db, schema, intent: "infer" | "ai" }
 * Relations that aren't declared as foreign keys, guessed from names or suggested by AI, checked against the data
 */
export const action: ActionFunction = async ({ request }) => {
    try {
        const user = await requireUser(request, "/login");
        const connection = await getSessionConnection(request);
        if (!connection) return Response.json({ message: "No connection selected" }, { status: 400 });
        const body = await request.json();
        const mongo = await dbConnection(connection);
        if (typeof body.db !== "string" || !mongo.isAllowed(body.db)) return Response.json({ message: "Access to this database is not allowed" }, { status: 403 });
        const pool = mongo.getPool(body.db);
        if (!pool) return Response.json({ message: "Could not connect to the database" }, { status: 500 });

        const schema = await loadDiagramSchema(pool, typeof body.schema === "string" ? body.schema : null);
        const byName = inferByName(schema);

        if (body.intent === "ai") {
            const settings = await userDb.user.findUnique({ where: { id: user.id }, select: { openAiApiKey: true, openAiBaseUrl: true, openAiModel: true } });
            if (!isAiConfigured(settings)) {
                return Response.json({ message: AI_NOT_CONFIGURED }, { status: 400 });
            }
            const suggestions = await inferWithAi(schema, byName, {
                baseUrl: (settings!.openAiBaseUrl || DEFAULT_AI_BASE_URL).replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, ""),
                apiKey: settings!.openAiApiKey || "",
                model: settings!.openAiModel || DEFAULT_AI_MODEL,
            });
            return Response.json({ relations: await verifyRelations(pool, schema, suggestions) });
        }

        return Response.json({ relations: await verifyRelations(pool, schema, byName) });
    } catch (e: any) {
        if (e instanceof Response) return e;
        return Response.json({ message: e.message }, { status: 500 });
    }
};
