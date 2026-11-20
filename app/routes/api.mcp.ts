import { ActionFunction, LoaderFunction } from "@remix-run/node";
import { requireUser } from "~/utils/session.server";
import { ensureMcpServer, mcpAvailable, mcpStatus, readMcpSettings, updateMcpSettings } from "~/lib/mcp.server";
import { WRITE_MODES, type WriteMode } from "~/lib/ai/tools.server";

/**
 * GET: the MCP server's settings and what to paste into each client, POST { enabled?, writeMode?, regenerateToken? }
 */
const describe = () => {
    const settings = readMcpSettings();
    const status = mcpStatus();
    const port = status.port ?? settings.port;
    return {
        available: true,
        enabled: settings.enabled,
        running: status.running,
        writeMode: settings.writeMode,
        url: `http://127.0.0.1:${port}/mcp`,
        token: settings.token,
        // electron/main.js: how Claude Desktop starts electron/mcp-bridge.cjs (the app's own executable as Node)
        bridge: process.env.PSQLCARBON_MCP_COMMAND ? JSON.parse(process.env.PSQLCARBON_MCP_COMMAND) : null,
    };
};

export const loader: LoaderFunction = async ({ request }) => {
    await requireUser(request, "/login");
    if (!mcpAvailable()) return Response.json({ available: false });
    await ensureMcpServer();
    return Response.json(describe(), { headers: { "Cache-Control": "no-store" } });
};

export const action: ActionFunction = async ({ request }) => {
    await requireUser(request, "/login");
    if (!mcpAvailable()) return Response.json({ message: "The MCP server is only in the downloadable app" }, { status: 400 });
    const body = await request.json().catch(() => ({}));
    try {
        await updateMcpSettings({
            enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
            writeMode: WRITE_MODES.includes(body.writeMode) ? (body.writeMode as WriteMode) : undefined,
            regenerateToken: body.regenerateToken === true,
        });
        return Response.json(describe());
    } catch (error: any) {
        return Response.json({ message: error?.message || "Could not save" }, { status: 500 });
    }
};
