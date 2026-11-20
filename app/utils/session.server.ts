import bcrypt from "bcryptjs";
import { createCookieSessionStorage, redirect, TypedResponse } from "@remix-run/node";
import { userDb } from "./db.server";
import { providerSummaries } from "./ai.server";
import type { ProviderSummary } from "./ai";
import type { DbConnection, User as PrismaUser } from "@prisma/client";

/**
 * Set by the desktop app (electron/main.js), there is no login since the app is only reachable from its own window
 */
export const isDesktop = () => process.env.PSQLCARBON_DESKTOP === "1";

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
	throw new Error("SESSION_SECRET must be set");
}

export type User = {
	id: string;
	createdAt: Date;
	updatedAt: Date;
	firstName?: string;
	newsletter?: boolean;
	hasOpenAiApiKey?: boolean;
	/** Saved providers with a hint of their key, the keys never leave the server */
	aiProviders?: ProviderSummary[];
	openAiBaseUrl?: string | null;
	openAiModel?: string | null;
};

function cleanupUser<TResult = User, TUser extends Partial<PrismaUser> = PrismaUser>(user: TUser): TResult {
	return {
		id: user.id,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
		username: user.username,
		hasOpenAiApiKey: !!user.openAiApiKey,
		aiProviders: providerSummaries(user),
		openAiBaseUrl: user.openAiBaseUrl,
		openAiModel: user.openAiModel,
	} as unknown as TResult;
}

export async function requireUser(request: Request): Promise<User | null>;
/**
 * @throws Will throw a redirect response if the user is not avaliable
 */
export async function requireUser(request: Request, redirectToIfNotAvaliable: string): Promise<User>;
export async function requireUser(request: Request, redirectToIfNotAvaliable?: string): Promise<User | null> {
	const userId = await requireUserId(request, redirectToIfNotAvaliable as never);

	if (!userId) {
		return null;
	}

	const user = await userDb.user.findUnique({ where: { id: userId } });

	if (!user) {
		return null;
	}

	return cleanupUser(user);
}

export async function getUserDbConnection(userId, id) {
	return await userDb.dbConnection.findUnique({ where: { userId, id } });
}
/**
 * Only the connection id is kept in the (signed, not encrypted) session cookie,
 * the credentials are always loaded from the database.
 */
export async function getSessionConnection(request: Request) {
	const session = await getUserSession(request);
	const userId = session.get("userId");
	const connectionId = session.get("connectionId");
	if (typeof userId !== "string") {
		return null;
	}
	const connection = typeof connectionId === "string" ? await userDb.dbConnection.findUnique({ where: { id: connectionId, userId } }) : null;
	// The schema chosen for each database goes with it, so every route works in the same one (app/lib/db.ts)
	const withSchemas = <T extends { id: string }>(found: T) => ({ ...found, schemas: getSessionSchemas(session, found.id) });
	if (connection) {
		return withSchemas(connection);
	}
	// Nothing selected (or it was deleted): use the only saved connection, route loaders run in parallel so they all need the same answer
	const connections = await userDb.dbConnection.findMany({ where: { userId }, take: 2 });
	return connections.length === 1 ? withSchemas(connections[0]) : null;
}

type SessionSchemas = { [connectionId: string]: { [dbName: string]: string } };

function getSessionSchemas(session: Awaited<ReturnType<typeof getUserSession>>, connectionId: string): { [dbName: string]: string } {
	const all = session.get("schemas") as SessionSchemas | undefined;
	return all && typeof all === "object" && all[connectionId] && typeof all[connectionId] === "object" ? all[connectionId] : {};
}

/**
 * Remembers the schema to use for a database of a connection, returns the Set-Cookie header
 */
export async function setSessionSchema(request: Request, connectionId: string, dbName: string, schema: string) {
	const session = await getUserSession(request);
	const all = { ...((session.get("schemas") as SessionSchemas | undefined) || {}) };
	all[connectionId] = { ...(all[connectionId] || {}), [dbName]: schema };
	session.set("schemas", all);
	return commitSession(session);
}

export async function getUserDbConnections(userId) {
	return await userDb.dbConnection.findMany({ where: { userId } });
}

export async function updatePassword(userId, password) {
	const passwordHash = await bcrypt.hash(password, 10);
	return await userDb.user.update({ where: { id: userId }, data: { passwordHash: passwordHash } });
}

export async function addUserDbConnection(userId, connection: Omit<DbConnection, "id" | "userId">) {
	return await userDb.dbConnection.create({
		data: {
			...connection,
			userId,
		},
	});
}

export async function removeUserDbConnection(userId, connectionId) {
	return await userDb.dbConnection.delete({ where: { userId, id: connectionId } });
}

export async function updateUserDbConnection(userId, connectionId, connection: Omit<DbConnection, "id" | "userId">) {
	return await userDb.dbConnection.update({
		where: { id: connectionId, userId },
		data: {
			...connection,
		},
	});
}

const cookie = {
	name: "psqlcarbon_session",
	secure: process.env.SECURE_COOKIE === "1",
	secrets: [sessionSecret],
	path: "/",
	maxAge: 60 * 60 * 24 * 30,
	httpOnly: true,
};

const storage = createCookieSessionStorage({
	cookie: cookie,
});

const commitSession = storage.commitSession;

export { commitSession };
export function checkUserSession(request) {
	const url = new URL(request.url);
	const scheme = url.protocol.replace(":", "");

	if (scheme === "http" && cookie.secure) {
		throw new Error("Secure cookies cannot be used on HTTP connections, it is either you set SECURE_COOKIE=0 in your .env file or use https connection.");
	}
}

export async function createUserSession(userId: string, redirectTo: string): Promise<TypedResponse<never>> {
	const session = await storage.getSession();
	session.set("userId", userId);

	return redirect(redirectTo, {
		headers: {
			"Set-Cookie": await storage.commitSession(session),
		},
	});
}
export function getUserSession(request: Request) {
	return storage.getSession(request.headers.get("Cookie"));
}

export async function getUserId(request: Request) {
	const session = await getUserSession(request);
	const userId = session.get("userId");
	if (!userId || typeof userId !== "string") return null;
	return userId;
}

export async function getUser(request: Request) {
	const userId = await getUserId(request);
	if (typeof userId !== "string") {
		return null;
	}
	try {
		const user = await userDb.user.findUnique({
			where: { id: userId },
			select: { id: true, username: true },
		});
		return user;
	} catch {
		throw logout(request);
	}
}

export async function requireUserId(request: Request, redirectTo: string = new URL(request.url).pathname) {
	const session = await getUserSession(request);
	const userId = session.get("userId");
	if (!userId || typeof userId !== "string") {
		if (["", "/", "/login"].includes(redirectTo)) {
			throw redirect(`/login`);
		}
		const searchParams = new URLSearchParams([["redirectTo", redirectTo]]);
		throw redirect(`/login?${searchParams}`);
	}
	return userId;
}

type LoginForm = {
	username: string;
	password: string;
};

export async function register({ username, password }: LoginForm) {
	const passwordHash = await bcrypt.hash(password, 10);
	const user = await userDb.user.create({
		data: { username, passwordHash },
	});
	return { id: user.id, username };
}

export async function login({ username, password }: LoginForm) {
	const user = await userDb.user.findUnique({
		where: { username },
	});
	if (!user) return null;
	const isCorrectPassword = await bcrypt.compare(password, user.passwordHash);
	if (!isCorrectPassword) return null;
	return { id: user.id, username };
}

export async function logout(request: Request) {
	const session = await getUserSession(request);
	return redirect("/login", {
		headers: {
			"Set-Cookie": await storage.destroySession(session),
		},
	});
}
