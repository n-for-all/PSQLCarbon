// Serves the app to its window without a network server: requests to APP_ORIGIN are answered in this process by
// the Remix build and the files in build/client. No port is opened, so nothing else on the machine can reach the
// app, and the App Store build needs no "incoming connections" entitlement.
import { net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// *.localhost never leaves the machine and counts as a secure origin
export const APP_ORIGIN = "https://psqlcarbon.localhost";
const APP_HOST = new URL(APP_ORIGIN).hostname;

/**
 * Answers the window's requests with the Remix build. Electron doesn't handle cookies for responses made here,
 * so they're kept in the session's cookie store by hand: sent with each request, saved from each response.
 */
export function serveApp({ build, clientDir, session }) {
	return import("@remix-run/node").then(({ createRequestHandler }) => {
		const handleRequest = createRequestHandler(build, "production");

		const handler = async (request) => {
			const url = new URL(request.url);
			// Every other https request (fonts, GitHub) goes out as usual
			if (url.hostname !== APP_HOST) return net.fetch(request, { bypassCustomProtocolHandlers: true });

			const file = staticFile(clientDir, url.pathname);
			if (file && (request.method === "GET" || request.method === "HEAD")) {
				return net.fetch(pathToFileURL(file).href, { bypassCustomProtocolHandlers: true });
			}

			const cookies = await session.cookies.get({ url: APP_ORIGIN });
			const headers = new Headers(request.headers);
			if (cookies.length) headers.set("cookie", cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "));
			const hasBody = request.method !== "GET" && request.method !== "HEAD";
			const response = await handleRequest(
				new Request(request.url, { method: request.method, headers, body: hasBody ? request.body : undefined, duplex: hasBody ? "half" : undefined, signal: request.signal })
			);
			await Promise.all(response.headers.getSetCookie().map((header) => saveCookie(session, header)));
			return response;
		};
		session.protocol.handle("https", handler);
	});
}

/**
 * A file in build/client for this path, the app's own assets. Paths can't leave the folder.
 */
function staticFile(clientDir, pathname) {
	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	const file = path.join(clientDir, decoded);
	if (!file.startsWith(clientDir + path.sep)) return null;
	try {
		return fs.statSync(file).isFile() ? file : null;
	} catch {
		return null;
	}
}

/**
 * Stores one Set-Cookie header in the session's cookie store
 */
function saveCookie(session, header) {
	const [pair, ...attributes] = header.split(";").map((part) => part.trim());
	const separator = pair.indexOf("=");
	if (separator < 1) return;
	const cookie = { url: APP_ORIGIN, name: pair.slice(0, separator), value: pair.slice(separator + 1), path: "/" };
	for (const attribute of attributes) {
		const [key, ...rest] = attribute.split("=");
		const value = rest.join("=");
		switch (key.toLowerCase()) {
			case "path":
				cookie.path = value || "/";
				break;
			case "max-age":
				cookie.expirationDate = Date.now() / 1000 + Number(value);
				break;
			case "expires":
				if (cookie.expirationDate === undefined) cookie.expirationDate = new Date(value).getTime() / 1000;
				break;
			case "httponly":
				cookie.httpOnly = true;
				break;
			case "secure":
				cookie.secure = true;
				break;
			case "samesite":
				cookie.sameSite = { lax: "lax", strict: "strict", none: "no_restriction" }[value.toLowerCase()] || "lax";
				break;
		}
	}
	// An expiry in the past is how a cookie is removed
	if (cookie.expirationDate !== undefined && cookie.expirationDate * 1000 <= Date.now()) {
		return session.cookies.remove(APP_ORIGIN, cookie.name);
	}
	return session.cookies.set(cookie);
}
