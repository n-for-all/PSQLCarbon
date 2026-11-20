import type { Pool } from "pg";
import { executeTool, listTables, NEEDS_APPROVAL, TOOL_DEFINITIONS, type ToolDisplay, type WriteMode } from "./tools.server";

// Model calls per user message, each call can run several tools
const MAX_STEPS = 25;
// Small local models can call the same tool with the same arguments over and over, after this many repeats in one
// request the run stops instead of using up every step
const MAX_REPEATED_CALLS = 2;
// Rough size of the history sent to the model, older turns are dropped first
const MAX_HISTORY_CHARS = 150_000;

export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	/** UI only, never sent to the model */
	display?: ToolDisplay;
	createdAt?: number;
}

export type AgentEvent =
	| { type: "message"; message: ChatMessage }
	| { type: "approval"; toolCallId: string; sql: string }
	| { type: "error"; message: string };

export interface AgentOptions {
	messages: ChatMessage[];
	database: string;
	resolvePool: (database?: string) => { pool: Pool; database: string };
	listDatabases: () => Promise<string[]>;
	table?: string | null;
	writeMode: WriteMode;
	userId: string;
	connectionId: string;
	memories: { id: string; content: string }[];
	api: { baseUrl: string; apiKey: string; model: string; referer: string };
	/** Decisions for tool calls waiting on the user, keyed by tool call id */
	approvals?: Record<string, boolean>;
	signal?: AbortSignal;
	emit: (event: AgentEvent) => void;
	save: (messages: ChatMessage[]) => Promise<void>;
}

const WRITE_MODE_PROMPTS: Record<WriteMode, string> = {
	read_only: "Changes are disabled: statements that modify data or schema are refused. If the user asks for a change, show the SQL you would run in a sql code block instead.",
	ask: "Statements that modify data or schema need the user's approval: call run_query with them and the user approves or rejects it in the app. Don't ask for permission in text first.",
	auto: "Statements that modify data or schema run immediately without approval. Be careful: check what will be affected with a read query first and prefer precise WHERE clauses.",
};

async function systemPrompt(options: AgentOptions) {
	let tables = "";
	try {
		const list = await listTables(options.resolvePool().pool);
		tables = list
			.slice(0, 200)
			.map((table: any) => `- ${table.schema}.${table.name} (${table.type}${table.estimated_rows != null ? `, ~${table.estimated_rows} rows` : ""})`)
			.join("\n");
		if (list.length > 200) tables += `\n- …and ${list.length - 200} more, use list_tables`;
	} catch (error: any) {
		tables = `(could not list tables: ${error.message})`;
	}

	// The schema the user picked in the sidebar, the connection's search_path (app/lib/db.ts)
	let currentSchema = "";
	try {
		currentSchema = (await options.resolvePool().pool.query("SELECT current_schema() AS schema")).rows[0]?.schema || "";
	} catch {}

	let databases: string[] = [];
	try {
		databases = await options.listDatabases();
	} catch {
		// listed on demand with list_databases
	}

	return `You are the PostgreSQL assistant inside PSQLCarbon, a database admin app. This chat's database is "${options.database}".
Databases on this server you can use: ${databases.length ? databases.map((name) => `"${name}"`).join(", ") : "(use list_databases)"}.
A SQL query only sees one database, so to work in another one pass its name as \`database\` to list_tables, describe_table or run_query. When the user names a database, use it, don't assume they mean the chat's database.
${options.table ? `The user currently has the table "${options.table}" open.\n` : ""}Today is ${new Date().toISOString().slice(0, 10)}.

Work with the real data: use your tools to look at tables and run queries yourself instead of guessing or asking the user to run them. Inspect a table with describe_table before querying it if you haven't seen it in this chat. When a query fails, read the error, fix the query and try again. Keep going until the user's request is fully done, then answer with a short summary of the results.

Query rules:
- Always double quote table and column names, e.g. SELECT "id" FROM "public"."Users".
- Use LIMIT for exploratory reads and aggregates for large tables, results you see are capped.
- Reads run in a read only transaction, one statement per run_query call.
- ${WRITE_MODE_PROMPTS[options.writeMode]}

To give the user a file, use export_query_results (query results as CSV/JSON) or create_backup (a database backup), they show a download button.
When you show SQL to the user, put it in a \`\`\`sql code block. Use save_memory for durable facts worth knowing in future chats about this database.

Tables in "${options.database}":
${tables || "(none)"}
${currentSchema ? `The user is working in the "${currentSchema}" schema: unqualified table names resolve to it, and "the tables" means its tables unless they say otherwise.\n` : ""}
${
	options.memories.length
		? `\nThings you saved about this database earlier (memory id: content):\n${options.memories.map((memory) => `- ${memory.id}: ${memory.content}`).join("\n")}\n`
		: ""
}`;
}

/**
 * Keeps the newest turns that fit, always starting at a user message so tool calls keep their results
 */
function historyForModel(messages: ChatMessage[]) {
	const apiMessages = messages.map(({ role, content, tool_calls, tool_call_id }) => ({
		role,
		content,
		...(tool_calls?.length ? { tool_calls } : {}),
		...(tool_call_id ? { tool_call_id } : {}),
	}));

	let size = 0;
	let start = apiMessages.length;
	for (let i = apiMessages.length - 1; i >= 0; i--) {
		size += JSON.stringify(apiMessages[i]).length;
		if (size > MAX_HISTORY_CHARS) break;
		if (apiMessages[i].role === "user") start = i;
	}
	// Always keep the latest user message even if it alone is too large
	if (start === apiMessages.length) {
		const lastUser = apiMessages.map((m) => m.role).lastIndexOf("user");
		start = lastUser === -1 ? 0 : lastUser;
	}
	return apiMessages.slice(start);
}

async function callModel(options: AgentOptions, system: string, messages: ChatMessage[]): Promise<ChatMessage> {
	const { baseUrl, apiKey, model, referer } = options.api;
	const targetUrl = `${baseUrl}/chat/completions`;
	const response = await fetch(targetUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			// Local servers like LM Studio and Ollama need no key
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			"HTTP-Referer": referer,
			"X-Title": "PSQL Carbon AI Assistant",
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "system", content: system }, ...historyForModel(messages)],
			tools: TOOL_DEFINITIONS,
			tool_choice: "auto",
			temperature: 0.1,
		}),
		signal: options.signal,
	});

	if (!response.ok) {
		const errText = await response.text();
		let detail = errText || response.statusText;
		try {
			const parsed = JSON.parse(errText);
			detail = parsed.error?.message || parsed.message || detail;
		} catch {
			// not JSON
		}
		throw new Error(`AI API Error: ${detail} (URL: ${targetUrl})`);
	}

	const data = await response.json();
	const message = data.choices?.[0]?.message;
	if (!message) {
		throw new Error("The AI API returned no message");
	}
	// Reasoning models put their thinking in the content, it isn't part of the answer
	let content: string | null = typeof message.content === "string" ? message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || null : null;
	let toolCalls: ToolCall[] = message.tool_calls?.length ? message.tool_calls : [];
	if (!toolCalls.length && content) {
		toolCalls = toolCallsFromText(content);
		if (toolCalls.length) content = null;
	}
	return {
		role: "assistant",
		content,
		...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		createdAt: Date.now(),
	};
}

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.function.name));

/**
 * Some local models write tool calls as text instead of using the tool calling API:
 * a JSON object or array, in a ```json block or in <tool_call> tags
 */
export function toolCallsFromText(text: string): ToolCall[] {
	const candidates = [
		...[...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)].map((match) => match[1]),
		...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]),
		text,
	];
	for (const candidate of candidates) {
		let parsed: any;
		try {
			parsed = JSON.parse(candidate.trim());
		} catch {
			continue;
		}
		const calls = (Array.isArray(parsed) ? parsed : [parsed])
			.map((item: any) => item?.function || item)
			.filter((item: any) => item && typeof item.name === "string" && TOOL_NAMES.has(item.name));
		if (calls.length) {
			return calls.map((call: any, i: number) => ({
				id: `call_text_${Date.now()}_${i}`,
				type: "function" as const,
				function: { name: call.name, arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? call.parameters ?? {}) },
			}));
		}
	}
	return [];
}

/**
 * Tool calls of the last assistant message that have no result yet
 */
export function unansweredToolCalls(messages: ChatMessage[]) {
	const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
	if (lastAssistant === -1 || !messages[lastAssistant].tool_calls?.length) return [];
	const answered = new Set(messages.slice(lastAssistant + 1).map((m) => m.tool_call_id));
	return messages[lastAssistant].tool_calls!.filter((call) => !answered.has(call.id));
}

/**
 * Whether a tool call with the same name and arguments already has a result since the latest user message
 */
export function isRepeatedCall(messages: ChatMessage[], call: ToolCall) {
	const lastUser = messages.map((m) => m.role).lastIndexOf("user");
	const normalize = (text: string) => {
		try {
			return JSON.stringify(JSON.parse(text || "{}"));
		} catch {
			return text;
		}
	};
	const key = `${call.function.name}:${normalize(call.function.arguments)}`;
	const turn = messages.slice(lastUser + 1);
	const answered = new Set(turn.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
	return turn.some(
		(m) => m.role === "assistant" && m.tool_calls?.some((earlier) => earlier.id !== call.id && answered.has(earlier.id) && `${earlier.function.name}:${normalize(earlier.function.arguments)}` === key)
	);
}

/**
 * Runs the tool loop until the model answers without tools, a change needs the user's approval or the request is stopped
 */
export async function runAgent(options: AgentOptions) {
	const messages = options.messages;
	const append = async (message: ChatMessage) => {
		messages.push(message);
		options.emit({ type: "message", message });
		await options.save(messages);
	};

	const system = await systemPrompt(options);
	let repeatedCalls = 0;

	for (let step = 0; step <= MAX_STEPS; step++) {
		for (const call of unansweredToolCalls(messages)) {
			if (options.signal?.aborted) return;

			// The same call already ran for this request: its result is in the chat, so the model is pointed back to it
			if (isRepeatedCall(messages, call)) {
				repeatedCalls++;
				await append({
					role: "tool",
					tool_call_id: call.id,
					content: JSON.stringify({
						error: `You already called ${call.function.name} with these arguments for this request and its result is above. Don't call it again: use that result, call a different tool (for example describe_table or run_query on specific tables) or give your answer.`,
					}),
					display: { tool: call.function.name, skipped: true, text: "Already done, skipped" },
					createdAt: Date.now(),
				});
				continue;
			}

			let args: any = {};
			try {
				args = JSON.parse(call.function.arguments || "{}");
			} catch {
				await append({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "The tool arguments are not valid JSON" }), display: { tool: call.function.name, error: "Invalid arguments" } });
				continue;
			}

			const outcome = await executeTool(call.function.name, args, {
				database: options.database,
				resolvePool: options.resolvePool,
				listDatabases: options.listDatabases,
				writeMode: options.writeMode,
				userId: options.userId,
				connectionId: options.connectionId,
				approved: options.approvals?.[call.id],
			});

			if (outcome === NEEDS_APPROVAL) {
				options.emit({ type: "approval", toolCallId: call.id, sql: args.sql });
				return;
			}
			await append({ role: "tool", tool_call_id: call.id, content: outcome.content, display: outcome.display, createdAt: Date.now() });
		}

		const last = messages[messages.length - 1];
		if (last?.role === "assistant" && !last.tool_calls?.length) return;
		if (options.signal?.aborted) return;
		if (repeatedCalls > MAX_REPEATED_CALLS) {
			options.emit({
				type: "error",
				message: "Stopped: the assistant kept repeating the same step. Smaller models do this with broad requests, try a more specific question (one table or one problem) or a larger model.",
			});
			return;
		}
		if (step === MAX_STEPS) {
			options.emit({ type: "error", message: `Stopped after ${MAX_STEPS} steps, send "continue" to let the assistant keep going.` });
			return;
		}

		await append(await callModel(options, system, messages));
	}
}
