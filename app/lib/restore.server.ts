import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import type { UserConnection } from "~/types";
import { toolEnvironment, type PgTool } from "./backup.server";

export type RestoreEvent =
	| { type: "log"; message: string; level?: "info" | "warning" | "error" }
	| { type: "progress"; bytes: number; totalBytes: number | null; statements: number; rows: number }
	| { type: "done"; ok: boolean; statements: number; rows: number; durationMs: number; message: string };

type Item = { kind: "statement"; sql: string; line: number } | { kind: "meta"; text: string; line: number } | { kind: "copy-start"; sql: string; line: number } | { kind: "copy-data"; data: string } | { kind: "copy-end" };

/**
 * Splits a SQL script into statements as it streams in. It understands quotes, E'' strings, quoted identifiers,
 * dollar quoted bodies, comments, psql meta commands and the data of COPY ... FROM stdin blocks from pg_dump.
 */
export class SqlSplitter {
	private buffer = "";
	private pos = 0;
	private start = 0;
	private line = 1;
	private startLine = 1;
	private state: "normal" | "single" | "escape-string" | "double" | "dollar" | "line-comment" | "block-comment" | "copy" = "normal";
	private dollarTag = "";
	// The rest of the COPY ... FROM stdin; line isn't data
	private skipCopyLine = false;
	private blockDepth = 0;

	push(text: string): Item[] {
		this.buffer += text;
		return this.scan(false);
	}

	end(): Item[] {
		const items = this.scan(true);
		if (this.state === "copy") {
			const rest = this.buffer.slice(this.start);
			if (rest) items.push({ kind: "copy-data", data: rest });
			items.push({ kind: "copy-end" });
		} else {
			const rest = this.buffer.slice(this.start).trim();
			if (rest && !/^(--[^\n]*\n?|\s)*$/.test(rest)) items.push({ kind: "statement", sql: rest, line: this.startLine });
		}
		this.buffer = "";
		this.pos = this.start = 0;
		return items;
	}

	private compact() {
		// Drop what was consumed so a large file never sits in memory
		if (this.start > 65536) {
			this.buffer = this.buffer.slice(this.start);
			this.pos -= this.start;
			this.start = 0;
		}
	}

	private scan(final: boolean): Item[] {
		const items: Item[] = [];
		// Re-read after compact(), which shortens the buffer and moves pos back
		let b = this.buffer;
		const needMore = (count: number) => !final && this.pos + count >= b.length;

		while (this.pos < b.length) {
			if (this.state === "copy") {
				// Data lines until a line with only \.
				const newline = b.indexOf("\n", this.pos);
				if (newline === -1) {
					if (final) this.pos = b.length;
					break;
				}
				if (this.skipCopyLine) {
					this.skipCopyLine = false;
					this.pos = this.start = newline + 1;
					this.line++;
					continue;
				}
				const lineText = b.slice(this.pos, newline).replace(/\r$/, "");
				if (lineText === "\\.") {
					if (this.pos > this.start) items.push({ kind: "copy-data", data: b.slice(this.start, this.pos) });
					items.push({ kind: "copy-end" });
					this.state = "normal";
					this.pos = this.start = newline + 1;
					this.line++;
					this.startLine = this.line;
					continue;
				}
				this.pos = newline + 1;
				this.line++;
				// Hand data over in pieces so big tables stream
				if (this.pos - this.start > 1 << 20) {
					items.push({ kind: "copy-data", data: b.slice(this.start, this.pos) });
					this.start = this.pos;
				}
				continue;
			}

			const ch = b[this.pos];
			const next = b[this.pos + 1];

			if (this.state === "normal") {
				// A psql meta command (\connect, \restrict ...) at the start of a statement takes the rest of the line
				if (ch === "\\" && (this.pos === 0 || b[this.pos - 1] === "\n") && stripLeadingComments(b.slice(this.start, this.pos)).trim() === "") {
					const newline = b.indexOf("\n", this.pos);
					if (newline === -1 && !final) break;
					const end = newline === -1 ? b.length : newline;
					items.push({ kind: "meta", text: b.slice(this.pos, end).trim(), line: this.line });
					this.pos = this.start = end + 1;
					this.line++;
					this.startLine = this.line;
					continue;
				}
				if (ch === "'") {
					const prev = b[this.pos - 1];
					const beforePrev = b[this.pos - 2];
					this.state = (prev === "E" || prev === "e") && !/[A-Za-z0-9_$]/.test(beforePrev || "") ? "escape-string" : "single";
				} else if (ch === '"') {
					this.state = "double";
				} else if (ch === "-" && (next === undefined ? !final : next === "-")) {
					if (next === undefined) break;
					this.state = "line-comment";
				} else if (ch === "/" && (next === undefined ? !final : next === "*")) {
					if (next === undefined) break;
					this.state = "block-comment";
					this.blockDepth = 1;
					this.pos++;
				} else if (ch === "$" && !/[A-Za-z0-9_]/.test(b[this.pos - 1] || "")) {
					const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(b.slice(this.pos, this.pos + 64));
					if (match) {
						this.state = "dollar";
						this.dollarTag = match[0];
						this.pos += match[0].length;
						continue;
					}
					if (needMore(64) && /^\$[A-Za-z0-9_]*$/.test(b.slice(this.pos))) break;
				} else if (ch === ";") {
					const sql = b.slice(this.start, this.pos + 1).trim();
					this.pos++;
					this.start = this.pos;
					const startLine = this.startLine;
					this.startLine = this.line;
					if (/^COPY\b[\s\S]*\bFROM\s+stdin\b/i.test(stripLeadingComments(sql))) {
						items.push({ kind: "copy-start", sql, line: startLine });
						// Data starts on the next line
						const newline = b.indexOf("\n", this.pos);
						if (newline === -1 && !final) {
							this.state = "copy";
							this.skipCopyLine = true;
							continue;
						}
						this.pos = this.start = newline === -1 ? b.length : newline + 1;
						this.line++;
						this.startLine = this.line;
						this.state = "copy";
					} else if (stripLeadingComments(sql) !== ";") {
						items.push({ kind: "statement", sql, line: startLine });
					}
					this.compact();
					b = this.buffer;
					continue;
				}
			} else if (this.state === "single" || this.state === "double") {
				const quote = this.state === "single" ? "'" : '"';
				if (ch === quote) {
					if (next === undefined && !final) break;
					if (next === quote) this.pos++;
					else this.state = "normal";
				}
			} else if (this.state === "escape-string") {
				if (ch === "\\") this.pos++;
				else if (ch === "'") {
					if (next === undefined && !final) break;
					if (next === "'") this.pos++;
					else this.state = "normal";
				}
			} else if (this.state === "dollar") {
				if (ch === "$") {
					if (needMore(this.dollarTag.length) && b.length - this.pos < this.dollarTag.length) break;
					if (b.startsWith(this.dollarTag, this.pos)) {
						this.pos += this.dollarTag.length;
						this.state = "normal";
						continue;
					}
				}
			} else if (this.state === "line-comment") {
				if (ch === "\n") this.state = "normal";
			} else if (this.state === "block-comment") {
				if (ch === "*" && next === "/") {
					this.blockDepth--;
					this.pos++;
					if (this.blockDepth === 0) this.state = "normal";
				} else if (ch === "/" && next === "*") {
					this.blockDepth++;
					this.pos++;
				} else if ((ch === "*" || ch === "/") && next === undefined && !final) break;
			}

			if (ch === "\n") this.line++;
			this.pos++;
		}
		return items;
	}
}

const stripLeadingComments = (sql: string) => sql.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, "");

// Ownership and privileges refer to roles that often don't exist where a backup is restored
const OWNERSHIP = /^(ALTER\s+[\s\S]+\s+OWNER\s+TO\s|GRANT\s|REVOKE\s|ALTER\s+DEFAULT\s+PRIVILEGES\s)/i;

const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b;
const isArchive = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5)) === "PGDMP";

/**
 * Reads the first bytes of an upload to tell plain SQL, gzip and pg_dump archives apart, then hands back
 * a stream that still starts at the beginning
 */
export async function detectFormat(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	const first = await reader.read();
	const head = first.value || new Uint8Array();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			if (head.length) controller.enqueue(head);
		},
		async pull(controller) {
			const { value, done } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			reader.cancel(reason);
		},
	});

	if (isGzip(head)) {
		const gunzipped = Readable.fromWeb(stream as any).pipe(createGunzip());
		const inner = Readable.toWeb(gunzipped) as unknown as ReadableStream<Uint8Array>;
		const detected = await detectFormat(inner);
		return { ...detected, gzip: true };
	}
	return { format: isArchive(head) ? ("archive" as const) : ("sql" as const), stream, gzip: false };
}

/**
 * Runs a plain SQL script statement by statement on one connection
 */
export async function restoreSql(
	pool: Pool,
	stream: ReadableStream<Uint8Array>,
	options: { singleTransaction: boolean; skipOwnership: boolean; totalBytes: number | null; signal?: AbortSignal },
	emit: (event: RestoreEvent) => void
) {
	const started = Date.now();
	const client = await pool.connect();
	const splitter = new SqlSplitter();
	const decoder = new TextDecoder();
	let statements = 0;
	let rows = 0;
	let bytes = 0;
	let skipped = 0;
	let copy: { stream: any; done: Promise<void>; table: string } | null = null;
	let lastProgress = 0;

	const progress = (force = false) => {
		if (force || Date.now() - lastProgress > 250) {
			lastProgress = Date.now();
			emit({ type: "progress", bytes, totalBytes: options.totalBytes, statements, rows });
		}
	};

	const run = async (item: Item) => {
		switch (item.kind) {
			case "meta":
				emit({ type: "log", level: "warning", message: `Line ${item.line}: skipped psql command ${item.text.split(/\s/)[0]}` });
				return;
			case "statement": {
				if (options.skipOwnership && OWNERSHIP.test(stripLeadingComments(item.sql))) {
					skipped++;
					return;
				}
				try {
					const result: any = await client.query(item.sql);
					statements++;
					const last = Array.isArray(result) ? result[result.length - 1] : result;
					if (/^INSERT/i.test(last?.command || "")) rows += last.rowCount || 0;
				} catch (error: any) {
					error.restoreLine = item.line;
					error.restoreSql = item.sql;
					throw error;
				}
				return;
			}
			case "copy-start": {
				const target = /^COPY\s+(\S+)/i.exec(stripLeadingComments(item.sql))?.[1] || "table";
				const copyStream = client.query(copyFrom(item.sql.replace(/;\s*$/, "")));
				const done = new Promise<void>((resolve, reject) => {
					copyStream.on("finish", resolve);
					copyStream.on("error", (error: any) => {
						error.restoreLine = item.line;
						error.restoreSql = item.sql;
						reject(error);
					});
				});
				done.catch(() => undefined);
				copy = { stream: copyStream, done, table: target };
				return;
			}
			case "copy-data":
				if (copy && !copy.stream.write(item.data)) {
					await new Promise((resolve) => copy!.stream.once("drain", resolve));
				}
				return;
			case "copy-end": {
				if (!copy) return;
				const current: { stream: any; done: Promise<void> } = copy;
				current.stream.end();
				await current.done;
				statements++;
				rows += Number(current.stream.rowCount || 0);
				copy = null;
				return;
			}
		}
	};

	let ok = false;
	let message = "";
	try {
		if (options.singleTransaction) await client.query("BEGIN");
		const reader = stream.getReader();
		for (;;) {
			if (options.signal?.aborted) throw new Error("Restore cancelled");
			const { value, done } = await reader.read();
			const items = done ? splitter.push(decoder.decode()).concat(splitter.end()) : splitter.push(decoder.decode(value, { stream: true }));
			if (value) bytes += value.length;
			for (const item of items) await run(item);
			progress();
			if (done) break;
		}
		if (options.singleTransaction) await client.query("COMMIT");
		ok = true;
		message = `Restored ${statements} statements and ${rows.toLocaleString()} rows${skipped ? `, skipped ${skipped} ownership/privilege statements` : ""}`;
	} catch (error: any) {
		if (options.singleTransaction) await client.query("ROLLBACK").catch(() => undefined);
		const where = error.restoreLine ? ` (line ${error.restoreLine})` : "";
		message = `${error.message}${where}${options.singleTransaction ? ". Nothing was restored, the whole restore was rolled back." : `. ${statements} statements before it were restored.`}`;
		emit({ type: "log", level: "error", message });
		if (error.restoreSql) emit({ type: "log", level: "error", message: `Statement: ${String(error.restoreSql).slice(0, 500)}` });
	} finally {
		// The script may have changed session settings, close the connection instead of reusing it
		client.release(true);
	}
	progress(true);
	emit({ type: "done", ok, statements, rows, durationMs: Date.now() - started, message });
}

/**
 * Restores a pg_dump archive (custom format) with pg_restore, the archive is piped through stdin
 */
export async function restoreArchive(
	tool: PgTool,
	connection: UserConnection,
	database: string,
	stream: ReadableStream<Uint8Array>,
	options: { singleTransaction: boolean; skipOwnership: boolean; totalBytes: number | null; signal?: AbortSignal },
	emit: (event: RestoreEvent) => void
) {
	const started = Date.now();
	const { env, cleanup } = toolEnvironment(connection, database);
	const args = ["--dbname", database, "--verbose"];
	if (options.skipOwnership) args.push("--no-owner", "--no-privileges");
	if (options.singleTransaction) args.push("--single-transaction", "--exit-on-error");
	const child = spawn(tool.path, args, { env, windowsHide: true });
	options.signal?.addEventListener("abort", () => child.kill());

	let errors = 0;
	let partial = "";
	child.stderr.on("data", (chunk) => {
		const lines = (partial + chunk.toString()).split("\n");
		partial = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const level = /error/i.test(line) ? "error" : /warning/i.test(line) ? "warning" : "info";
			if (level === "error") errors++;
			emit({ type: "log", level, message: line.replace(/^pg_restore:\s*/, "") });
		}
	});

	let bytes = 0;
	const exit = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
	try {
		const reader = stream.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.length;
			if (!child.stdin.write(value)) await new Promise((resolve) => child.stdin.once("drain", resolve));
			emit({ type: "progress", bytes, totalBytes: options.totalBytes, statements: 0, rows: 0 });
		}
	} catch (error: any) {
		emit({ type: "log", level: "error", message: error.message });
	}
	child.stdin.end();
	const code = await exit;
	cleanup();
	const ok = code === 0;
	emit({
		type: "done",
		ok,
		statements: 0,
		rows: 0,
		durationMs: Date.now() - started,
		message: ok ? "Restored with pg_restore" : `pg_restore finished with ${errors || "some"} errors${options.singleTransaction ? ", nothing was restored" : ""}`,
	});
}
