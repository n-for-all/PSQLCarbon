import { ActionFunction } from "@remix-run/node";
import { requireUser } from "~/utils/session.server";
import { userDb } from "~/utils/db.server";
import { readProviders } from "~/utils/ai.server";
import { normalizeBaseUrl } from "~/utils/ai";

/**
 * POST { baseUrl, apiKey? } lists the models of an OpenAI compatible server (OpenAI, DeepSeek, LM Studio, Ollama ...).
 * The request is made by the server, so local servers work without CORS settings.
 */
export const action: ActionFunction = async ({ request }) => {
    const user = await requireUser(request, "/login");
    const body = await request.json();
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "") : "";
    if (!/^https?:\/\//.test(baseUrl)) {
        return Response.json({ message: "Enter the server address first, e.g. http://localhost:1234/v1" }, { status: 400 });
    }

    // A saved key is only used for the server it was saved for
    let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
        const saved = await userDb.user.findUnique({ where: { id: user.id } });
        if (saved) apiKey = readProviders(saved)[normalizeBaseUrl(baseUrl)]?.apiKey || "";
    }

    try {
        const response = await fetch(`${baseUrl}/models`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
            const text = await response.text();
            let detail = text.slice(0, 200);
            try {
                const parsed = JSON.parse(text);
                detail = parsed.error?.message || parsed.message || detail;
            } catch {
                // not JSON
            }
            return Response.json({ message: response.status === 401 || response.status === 403 ? `The API key was rejected: ${detail}` : `The server answered ${response.status}: ${detail}` }, { status: 400 });
        }
        const data = await response.json();
        const models: string[] = (data.data || data.models || []).map((model: any) => model.id || model.name).filter(Boolean);
        // Embedding models can't chat
        return Response.json({ models: models.filter((id) => !/embed/i.test(id)).sort() });
    } catch (error: any) {
        const message = error?.name === "TimeoutError" ? "The server didn't answer" : error?.cause?.code === "ECONNREFUSED" ? "Nothing is running at that address, is the server started?" : error.message;
        return Response.json({ message }, { status: 400 });
    }
};
