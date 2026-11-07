import fs from "node:fs";
import path from "node:path";

/**
 * In the desktop app, joining the early access list is remembered in a file next to its database, shared with
 * the splash screen (electron/main.js), so neither asks again. The web version has no such place.
 */
const marker = () => (process.env.PSQLCARBON_DATA_DIR ? path.join(process.env.PSQLCARBON_DATA_DIR, "early-access-joined") : null);

export function hasJoinedEarlyAccess() {
	const file = marker();
	return file ? fs.existsSync(file) : false;
}

export function rememberEarlyAccessJoined() {
	const file = marker();
	if (file) fs.writeFileSync(file, new Date().toISOString());
}
