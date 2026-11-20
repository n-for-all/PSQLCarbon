// Updates a self-hosted PSQLCarbon: pulls the latest code, installs, updates the user database, builds and
// restarts it in PM2. Run with `npm run update` (or pnpm). `--no-pull` skips the git pull, for copied files.
// Stops at the first failing step, the running app keeps running until the restart at the end.
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_NAME = "PSQLCarbon";
const args = process.argv.slice(2);

const step = (title) => console.log(`\n\x1b[1m\x1b[35m==> ${title}\x1b[0m`);
const fail = (message) => {
	console.error(`\n\x1b[31mUpdate stopped: ${message}\x1b[0m`);
	process.exit(1);
};
const has = (command) => spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
const run = (command, commandArgs, { allowFail = false } = {}) => {
	console.log(`$ ${command} ${commandArgs.join(" ")}`);
	const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", env: process.env });
	if (result.status !== 0 && !allowFail) fail(`"${command} ${commandArgs.join(" ")}" failed`);
	return result.status === 0;
};
const bin = (name) => path.join(root, "node_modules", ".bin", name);

// pnpm when the install was made with it (node_modules/.pnpm) or the project uses it, npm otherwise
const usePnpm = has("pnpm") && (fs.existsSync(path.join(root, "node_modules", ".pnpm")) || fs.existsSync(path.join(root, "pnpm-lock.yaml")));
const pm = usePnpm ? "pnpm" : "npm";

// 1. Latest code
if (!args.includes("--no-pull") && fs.existsSync(path.join(root, ".git"))) {
	step("Getting the latest code");
	const changed = execSync("git status --porcelain --untracked-files=no", { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter((line) => line.trim() && !/package-lock\.json$|pnpm-lock\.yaml$/.test(line));
	if (changed.length) fail(`these files were changed on this server, commit or undo them first (git checkout -- <file>):\n${changed.join("\n")}`);
	// A lockfile of the other package manager or changed by an install would block the pull
	run("git", ["checkout", "--", "."], { allowFail: true });
	run("git", ["pull", "--ff-only"]);
}

// 2. Dependencies (the postinstall keeps the existing .env)
step(`Installing dependencies with ${pm}`);
run(pm, ["install"]);

// 3. The user database: back it up, then add the new columns and tables
step("Updating the user database");
// Read directly, this script only uses Node's own modules so it runs before anything is installed
const envFile = path.join(root, ".env");
const envMatch = fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8").match(/^\s*DATABASE_URL\s*=\s*["']?([^"'\n]+)["']?/m);
const databaseUrl = (envMatch && envMatch[1].trim()) || process.env.DATABASE_URL || "";
if (!databaseUrl) fail("DATABASE_URL is missing in .env, run `node console/install.js` first");
const dbFile = databaseUrl.startsWith("file:") ? path.resolve(root, "prisma", databaseUrl.slice(5)) : null;
if (dbFile && fs.existsSync(dbFile)) {
	const backup = `${dbFile}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	fs.copyFileSync(dbFile, backup);
	console.log(`Backup: ${backup}`);
}
run(bin("prisma"), ["generate"]);
// Without --accept-data-loss, it stops instead of dropping anything
run(bin("prisma"), ["db", "push", "--skip-generate"]);

// 4. Build
step("Building");
run(pm, ["run", "build"]);

// 5. Restart
step("Restarting");
if (has("pm2")) {
	const list = spawnSync("pm2", ["jlist"], { encoding: "utf8" });
	let running = false;
	try {
		running = JSON.parse(list.stdout || "[]").some((app) => app.name === APP_NAME);
	} catch {}
	if (running) run("pm2", ["restart", APP_NAME, "--update-env"]);
	else run("pm2", ["start", "app.config.cjs"]);
	run("pm2", ["save"], { allowFail: true });
} else {
	console.log(`PM2 isn't installed, restart the app yourself (${pm} start).`);
}

console.log("\n\x1b[32mPSQLCarbon is updated.\x1b[0m");
