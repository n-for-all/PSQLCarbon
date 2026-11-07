import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";

/**
 * Finds PostgreSQL servers on this machine only: local ports and sockets,
 * ~/.pgpass, ~/.pg_service.conf and the PG* environment variables. Nothing on the network is scanned.
 */

const LOCAL_PORTS = [5432, 5433, 5434, 5435];

// The desktop app runs in the macOS App Sandbox (Mac App Store), which can't read ~/.pgpass, service files or
// socket files in /tmp. Every desktop build behaves the same, so these sources are only used by the web version.
const sandboxed = () => process.env.PSQLCARBON_DESKTOP === "1";
const SOCKET_DIRS = ["/tmp", "/var/run/postgresql", "/run/postgresql"];
const PROBE_TIMEOUT_MS = 2500;

export interface DetectedConnection {
	id: string;
	name: string;
	source: string;
	host: string;
	port: number;
	user: string;
	database: string;
	connectionString: string;
	status: "ready" | "needs_password" | "unreachable" | "error";
	message?: string;
	version?: string;
	databases?: string[];
	/** Other users that can log in to the same local server */
	logins?: { user: string; connectionString: string }[];
}

interface Candidate {
	name: string;
	source: string;
	host: string;
	port: number;
	user?: string;
	password?: string;
	database?: string;
}

const isSocketDir = (host: string) => host.startsWith("/");

const buildConnectionString = (candidate: Required<Pick<Candidate, "host" | "port" | "user" | "database">> & { password?: string }) => {
	const auth = encodeURIComponent(candidate.user) + (candidate.password ? `:${encodeURIComponent(candidate.password)}` : "");
	if (isSocketDir(candidate.host)) {
		return `postgresql://${auth}@localhost:${candidate.port}/${encodeURIComponent(candidate.database)}?host=${encodeURIComponent(candidate.host)}`;
	}
	return `postgresql://${auth}@${candidate.host}:${candidate.port}/${encodeURIComponent(candidate.database)}`;
};

const portOpen = (port: number, host = "127.0.0.1") =>
	new Promise<boolean>((resolve) => {
		const socket = net.connect({ port, host });
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(500, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});

// host:port:database:username:password, "\:" and "\\" are escapes, "*" matches anything
function readPgpass(): { host: string; port: string; database: string; user: string; password: string }[] {
	if (sandboxed()) return [];
	const file = process.env.PGPASSFILE || path.join(os.homedir(), ".pgpass");
	try {
		return fs
			.readFileSync(file, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim() && !line.trim().startsWith("#"))
			.map((line) => {
				const fields: string[] = [""];
				for (let i = 0; i < line.length; i++) {
					if (line[i] === "\\" && i + 1 < line.length) fields[fields.length - 1] += line[++i];
					else if (line[i] === ":" && fields.length < 5) fields.push("");
					else fields[fields.length - 1] += line[i];
				}
				const [host = "", port = "", database = "", user = "", password = ""] = fields;
				return { host, port, database, user, password };
			})
			.filter((entry) => entry.user && entry.user !== "*");
	} catch {
		return [];
	}
}

function pgpassPassword(host: string, port: number, database: string, user: string) {
	const local = ["localhost", "127.0.0.1", "::1"].includes(host) || isSocketDir(host);
	const match = (pattern: string, value: string) => pattern === "*" || pattern === value;
	return readPgpass().find(
		(entry) =>
			(match(entry.host, host) || (local && entry.host === "localhost")) && match(entry.port, String(port)) && match(entry.database, database) && match(entry.user, user)
	)?.password;
}

function readServiceFile(): Candidate[] {
	if (sandboxed()) return [];
	const file = process.env.PGSERVICEFILE || path.join(os.homedir(), ".pg_service.conf");
	try {
		const candidates: Candidate[] = [];
		let current: Record<string, string> | null = null;
		let name = "";
		const flush = () => {
			if (current) {
				candidates.push({
					name,
					source: `pg_service.conf [${name}]`,
					host: current.host || "localhost",
					port: Number(current.port) || 5432,
					user: current.user,
					password: current.password,
					database: current.dbname,
				});
			}
		};
		for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const section = line.match(/^\[(.+)\]$/);
			if (section) {
				flush();
				name = section[1];
				current = {};
			} else if (current) {
				const index = line.indexOf("=");
				if (index > 0) current[line.slice(0, index).trim()] = line.slice(index + 1).trim();
			}
		}
		flush();
		return candidates;
	} catch {
		return [];
	}
}

function fromEnvironment(): Candidate[] {
	if (sandboxed()) return [];
	const candidates: Candidate[] = [];
	const env = process.env;
	if (env.PGHOST || env.PGPORT || env.PGUSER || env.PGDATABASE) {
		candidates.push({
			name: "Environment (PG* variables)",
			source: "Environment variables",
			host: env.PGHOST || "localhost",
			port: Number(env.PGPORT) || 5432,
			user: env.PGUSER,
			password: env.PGPASSWORD,
			database: env.PGDATABASE,
		});
	}
	for (const key of ["DATABASE_URL", "POSTGRES_URL", "PG_URL"]) {
		const value = env[key];
		if (!value || !/^postgres(ql)?:\/\//.test(value)) continue;
		try {
			const url = new URL(value);
			candidates.push({
				name: key,
				source: `Environment ${key}`,
				host: url.searchParams.get("host") || url.hostname || "localhost",
				port: Number(url.port) || 5432,
				user: decodeURIComponent(url.username) || undefined,
				password: decodeURIComponent(url.password) || undefined,
				database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
			});
		} catch {
			// not a valid URL
		}
	}
	return candidates;
}

async function localServers(): Promise<Candidate[]> {
	const candidates: Candidate[] = [];
	const openPorts = new Set<number>();
	await Promise.all(
		LOCAL_PORTS.map(async (port) => {
			if (await portOpen(port)) openPorts.add(port);
		})
	);
	for (const port of LOCAL_PORTS) {
		if (openPorts.has(port)) {
			candidates.push({ name: `Local PostgreSQL :${port}`, source: `Local server on port ${port}`, host: "localhost", port });
			continue;
		}
		// Servers that only listen on a unix socket
		if (sandboxed()) continue;
		const dir = SOCKET_DIRS.find((socketDir) => fs.existsSync(path.join(socketDir, `.s.PGSQL.${port}`)));
		if (dir) {
			candidates.push({ name: `Local PostgreSQL socket :${port}`, source: `Local socket ${dir}`, host: dir, port });
		}
	}
	return candidates;
}

async function probe(candidate: Candidate & { user: string; database: string }) {
	const client = new Client({
		host: candidate.host,
		port: candidate.port,
		user: candidate.user,
		password: candidate.password || undefined,
		database: candidate.database,
		connectionTimeoutMillis: PROBE_TIMEOUT_MS,
	});
	// Without a password pg asks for one lazily and throws, treat that as needing a password
	try {
		await client.connect();
		const version = await client.query("SHOW server_version");
		const databases = await client.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1");
		return { status: "ready" as const, version: version.rows[0]?.server_version as string, databases: databases.rows.map((row) => row.datname as string) };
	} catch (error: any) {
		const message: string = error?.message || String(error);
		if (error?.code === "28P01" || /password/i.test(message)) {
			return { status: "needs_password" as const, message };
		}
		if (["ECONNREFUSED", "ENOENT", "ETIMEDOUT", "EHOSTUNREACH"].includes(error?.code) || error?.name === "AggregateError" || /timeout/i.test(message)) {
			return { status: "unreachable" as const, message: `Nothing is accepting connections on ${candidate.host}:${candidate.port}` };
		}
		return { status: "error" as const, message };
	} finally {
		await client.end().catch(() => undefined);
	}
}

export async function detectConnections(saved: { connectionString: string }[]): Promise<DetectedConnection[]> {
	const osUser = os.userInfo().username;
	const configured = [...readServiceFile(), ...fromEnvironment()];
	const local = await localServers();

	const endpointKey = (candidate: Candidate) => `${isSocketDir(candidate.host) ? "localhost" : candidate.host.replace("127.0.0.1", "localhost")}:${candidate.port}`;
	const candidates: (Candidate & { user: string; database: string })[] = [];
	for (const candidate of configured) {
		candidates.push({ ...candidate, user: candidate.user || osUser, database: candidate.database || candidate.user || osUser });
	}
	for (const candidate of local) {
		// Try the users ~/.pgpass knows for this port, then the OS user and postgres
		const users = new Set<string>();
		for (const entry of readPgpass()) {
			if ((entry.port === "*" || entry.port === String(candidate.port)) && ["*", "localhost", "127.0.0.1", "::1"].includes(entry.host)) users.add(entry.user);
		}
		users.add(osUser);
		users.add("postgres");
		for (const user of users) {
			candidates.push({ ...candidate, user, database: "postgres" });
		}
	}

	const seen = new Set<string>();
	const unique = candidates.filter((candidate) => {
		const key = `${endpointKey(candidate)}/${candidate.user}/${candidate.database}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	const results = await Promise.all(
		unique.map(async (candidate) => {
			const password = candidate.password || pgpassPassword(candidate.host, candidate.port, candidate.database, candidate.user);
			const result = await probe({ ...candidate, password });
			return {
				id: `${endpointKey(candidate)}/${candidate.user}/${candidate.database}`,
				name: candidate.name,
				source: candidate.source,
				host: candidate.host,
				port: candidate.port,
				user: candidate.user,
				database: candidate.database,
				connectionString: buildConnectionString({ ...candidate, password }),
				...result,
			};
		})
	);

	const savedKeys = new Set(saved.map((connection) => normalize(connection.connectionString)));
	const unsaved: DetectedConnection[] = results.filter((result) => !savedKeys.has(normalize(result.connectionString)));

	// A local server is tried with several users, show it once with the users that can log in
	const grouped: DetectedConnection[] = [];
	for (const result of unsaved) {
		if (!result.source.startsWith("Local")) {
			grouped.push(result);
			continue;
		}
		if (grouped.some((other) => other.source === result.source && endpointKey(other) === endpointKey(result))) continue;
		const attempts = unsaved.filter((other) => other.source === result.source && endpointKey(other) === endpointKey(result));
		const ready = attempts.filter((attempt) => attempt.status === "ready");
		grouped.push({
			...(ready[0] || attempts[0]),
			...(ready.length > 1 ? { logins: ready.map((attempt) => ({ user: attempt.user, connectionString: attempt.connectionString })) } : {}),
		});
	}

	return grouped.sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready"));
}

// Compares connection strings without passwords
function normalize(connectionString: string) {
	try {
		const url = new URL(connectionString);
		const host = url.searchParams.get("host") ? "localhost" : url.hostname.replace("127.0.0.1", "localhost");
		return `${host}:${url.port || 5432}/${decodeURIComponent(url.username)}/${decodeURIComponent(url.pathname.replace(/^\//, "")) || decodeURIComponent(url.username)}`;
	} catch {
		return connectionString;
	}
}
