// Connects Claude Desktop (and other clients that only start MCP servers as programs) to PSQLCarbon's MCP server.
// The client runs the app's own executable as Node (ELECTRON_RUN_AS_NODE=1) with this file, see app/routes/api.mcp.ts.
// Messages come in on stdin one per line, go to http://127.0.0.1:<port>/mcp, and the answers go out on stdout.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const dataDir = process.env.PSQLCARBON_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "PSQLCarbon");
const APP_ID = "com.psqlcarbon.app";
// How long to wait for the app when it had to be opened
const START_TIMEOUT_MS = 30_000;

const log = (...args) => process.stderr.write(`[psqlcarbon-mcp] ${args.join(" ")}\n`);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function settings() {
	try {
		return JSON.parse(fs.readFileSync(path.join(dataDir, "mcp.json"), "utf8"));
	} catch {
		return null;
	}
}

let opened = false;
function openApp() {
	if (opened || process.platform !== "darwin") return;
	opened = true;
	log("PSQLCarbon isn't running, opening it");
	spawn("open", ["-g", "-b", APP_ID], { stdio: "ignore", detached: true }).unref();
}

async function post(line) {
	const started = Date.now();
	for (;;) {
		const current = settings();
		if (!current || !current.enabled) {
			throw new Error("The MCP server is turned off, turn it on in PSQLCarbon: Settings > MCP server");
		}
		try {
			return await fetch(`http://127.0.0.1:${current.port}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${current.token}`, "User-Agent": "claude-desktop-bridge" },
				body: line,
			});
		} catch (error) {
			// Not running yet: open the app and wait for its server
			openApp();
			if (Date.now() - started > START_TIMEOUT_MS) throw new Error("Could not reach PSQLCarbon, open the app and make sure the MCP server is turned on");
			await sleep(500);
		}
	}
}

async function forward(line) {
	let ids = [];
	try {
		const parsed = JSON.parse(line);
		ids = (Array.isArray(parsed) ? parsed : [parsed]).filter((m) => m && m.id !== undefined && m.id !== null && m.method).map((m) => m.id);
	} catch {
		send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		return;
	}
	try {
		const response = await post(line);
		if (response.status === 202) return;
		const text = await response.text();
		if (text.trim()) process.stdout.write(text.trim() + "\n");
	} catch (error) {
		for (const id of ids) send({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message } });
	}
}

// One at a time, in order
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	queue = queue.then(() => forward(line));
}).on("close", () => {
	queue.then(() => process.exit(0));
});
