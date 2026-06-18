import { ActionFunction } from "@remix-run/node";
import { requireUser } from "~/utils/session.server";
import { userDb } from "~/utils/db.server";
import https from "https";

export const action: ActionFunction = async ({ request }) => {
    try {
        const user = await requireUser(request, "/login");
        const body = await request.json();
        const { prompt, history = [], db, table, columns } = body;

        const dbUser = await userDb.user.findUnique({ where: { id: user.id } });

        if (!dbUser?.openAiApiKey) {
            return Response.json({ message: "OpenAI API Key is not configured. Please go to Profile settings to configure it." }, { status: 400 });
        }

        const rawBaseUrl = dbUser.openAiBaseUrl || "https://api.openai.com/v1";
        const baseUrl = rawBaseUrl.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
        const model = dbUser.openAiModel || "gpt-4o";

        // Query the schema
        const session = await (await import("~/utils/session.server")).getUserSession(request);
        const connection = session.get("connection");
        if (!connection) {
            return Response.json({ message: "No connection selected" }, { status: 400 });
        }
        const mongo = await (await import("~/lib/db")).default(connection);
        const pool = mongo.getPool(db);
        let schemaInfo = "";

        if (pool) {
            try {
                const schemaQuery = `
                    SELECT table_name, column_name, data_type 
                    FROM information_schema.columns 
                    WHERE table_schema = 'public'
                    ORDER BY table_name, ordinal_position;
                `;
                const schemaRes = await pool.query(schemaQuery);
                const tablesMap = new Map<string, string[]>();

                for (const row of schemaRes.rows) {
                    if (!tablesMap.has(row.table_name)) {
                        tablesMap.set(row.table_name, []);
                    }
                    tablesMap.get(row.table_name)!.push(`${row.column_name} (${row.data_type})`);
                }

                const tablesContext = Array.from(tablesMap.entries())
                    .map(([tbl, cols]) => `- Table "${tbl}": ${cols.join(", ")}`)
                    .join("\n");

                schemaInfo = `\nHere is the full schema of the database:\n${tablesContext}\n`;
            } catch (e) {
                console.error("Failed to load full schema", e);
            }
        }

        const systemPrompt = `You are an AI assistant that writes PostgreSQL queries. 
The user is querying a PostgreSQL database named "${db}".
The currently active table in the UI is "${table}".
${schemaInfo}
Your task is to help the user with their database. You can answer questions conversationally based on the schema information provided.
CRITICAL INSTRUCTION: If you provide a SQL query, you MUST wrap it in markdown SQL code blocks (\`\`\`sql ... \`\`\`). NEVER provide raw SQL outside of a code block.
IMPORTANT: ALWAYS wrap table names and column names in double quotes (e.g. "TableName") in your SQL queries to prevent case-sensitivity errors in PostgreSQL.
You can include explanations or conversational text outside of the code blocks.`;

        const targetUrl = `${baseUrl}/chat/completions`;

        const reqUrl = new URL(request.url);
        const referer = reqUrl.origin && reqUrl.origin !== "null" ? reqUrl.origin : "http://localhost:5173";
        const response = await fetch(targetUrl, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${dbUser.openAiApiKey}`,
                "Referer": referer,
                "HTTP-Referer": referer,
                "Origin": referer,
                "X-Title": "PSQL Carbon AI Assistant",
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: systemPrompt },
                    ...history.map((msg: any) => ({ role: msg.role, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) })),
                    { role: "user", content: prompt }
                ],
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("OpenAI API Error:", errText);

            let detailedError = response.statusText;
            try {
                const parsed = JSON.parse(errText);
                if (parsed.error && parsed.error.message) {
                    detailedError = parsed.error.message;
                } else if (parsed.message) {
                    detailedError = parsed.message;
                } else {
                    detailedError = errText;
                }
            } catch {
                detailedError = errText || response.statusText;
            }

            return Response.json({ message: `AI API Error: ${detailedError} (URL: ${targetUrl})` }, { status: 500 });
        }

        const data = await response.json();
        let sql = data.choices[0].message.content.trim();



        return Response.json({ sql }, { status: 200 });

    } catch (e: any) {
        console.error("Chat Error:", e);
        return Response.json({ message: e.message }, { status: 500 });
    }
};
