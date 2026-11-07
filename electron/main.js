// Desktop app entry: runs the built Remix server inside Electron and opens it in a window.
// Build the web app first (`pnpm build`), then start with `pnpm app`.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { joinEarlyAccess } from "./early-access.js";
import { APP_ORIGIN, serveApp } from "./app-protocol.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// package.json has no "main" (so npm leaves this folder out of the package) and `pnpm app` starts this file directly,
// which means Electron doesn't read the name and version from it. Packaged builds get them from electron-builder.
let appVersion = app.getVersion();
if (!app.isPackaged) {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	appVersion = pkg.version;
	app.setName(pkg.productName);
	app.setPath("userData", path.join(app.getPath("appData"), pkg.productName));
}

const origin = APP_ORIGIN;
let mainWindow = null;

// Splash shown while the app starts, for at least SPLASH_MIN_MS, it never takes the focus
const SPLASH_MIN_MS = 2500;
// Until someone joins the early access list, the splash waits for them to join or skip before opening the app
let splash = null;
let splashShownAt = 0;
let splashHold = false;
let appReady = false;

/**
 * The desktop app keeps its own SQLite database and session secret in the OS user data folder,
 * this has to run before the server build is imported since it reads these on load.
 */
function prepareEnv() {
	const dataDir = app.getPath("userData");
	fs.mkdirSync(dataDir, { recursive: true });

	const secretFile = path.join(dataDir, "session-secret");
	if (!fs.existsSync(secretFile)) {
		fs.writeFileSync(secretFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
	}

	process.env.NODE_ENV = "production";
	process.env.PSQLCARBON_DESKTOP = "1";
	// The Mac App Store build: donation links aren't allowed there (App Review guideline 3.1.1)
	process.env.PSQLCARBON_APP_STORE = process.mas ? "1" : "0";
	// pg_dump and pg_restore that come with the app, prepared by scripts/fetch-pg-tools.mjs
	const platform = { darwin: "mac", win32: "win", linux: "linux" }[process.platform];
	process.env.PSQLCARBON_PG_TOOLS = app.isPackaged
		? path.join(process.resourcesPath, "pg-tools", "bin")
		: path.join(root, "electron", "pg-tools", `${platform}-${process.arch}`, "bin");
	process.env.SESSION_SECRET = fs.readFileSync(secretFile, "utf8").trim();
	process.env.DATABASE_URL = `file:${path.join(dataDir, "psqlcarbon.db")}`;
	// The app server keeps a few small files here too, like the early access marker (app/lib/early-access.server.ts)
	process.env.PSQLCARBON_DATA_DIR = dataDir;
}

/**
 * Applies prisma/migrations without the Prisma CLI, which is not shipped with the app
 */
async function migrate() {
	const { PrismaClient } = await import("@prisma/client");
	// A single connection so the foreign_keys pragma below applies to the migration transactions,
	// Prisma's SQLite migrations rebuild tables and expect foreign keys to be off while they do
	const db = new PrismaClient({ datasourceUrl: `${process.env.DATABASE_URL}?connection_limit=1` });
	try {
		await db.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
		await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_psqlcarbon_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
		const applied = new Set((await db.$queryRawUnsafe(`SELECT "name" FROM "_psqlcarbon_migrations"`)).map((row) => row.name));

		const dir = path.join(root, "prisma", "migrations");
		const migrations = fs
			.readdirSync(dir)
			.filter((name) => fs.existsSync(path.join(dir, name, "migration.sql")))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

		for (const name of migrations) {
			if (applied.has(name)) {
				continue;
			}
			const statements = fs
				.readFileSync(path.join(dir, name, "migration.sql"), "utf8")
				.replace(/^\s*--.*$/gm, "")
				.split(/;\s*(?:\r?\n|$)/)
				.map((statement) => statement.trim())
				.filter(Boolean);

			await db.$transaction([
				...statements.map((statement) => db.$executeRawUnsafe(statement)),
				db.$executeRawUnsafe(`INSERT INTO "_psqlcarbon_migrations" ("name") VALUES (?)`, name),
			]);
		}
		await db.$executeRawUnsafe("PRAGMA foreign_keys=ON");
	} finally {
		await db.$disconnect();
	}
}

/**
 * Answers the window's requests in this process (electron/app-protocol.js). There is no login in the desktop app,
 * and with no network server nothing but its own window can reach it.
 */
async function startApp() {
	const build = await import(pathToFileURL(path.join(root, "build", "server", "index.js")).href);
	await serveApp({ build, clientDir: path.join(root, "build", "client"), session: session.defaultSession });
}

function openExternal(url) {
	if (/^https?:\/\//.test(url)) {
		shell.openExternal(url);
	}
}

function createSplash() {
	splash = new BrowserWindow({
		width: 540,
		height: 440,
		frame: false,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		// Shown without taking the focus (showInactive below), clicking the email field gives it the focus
		center: true,
		show: false,
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#161618" : "#ffffff",
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			preload: path.join(root, "electron", "splash-preload.cjs"),
		},
	});
	splash.webContents.setWindowOpenHandler(({ url }) => {
		openExternal(url);
		return { action: "deny" };
	});
	splash.webContents.on("will-navigate", (event, url) => {
		event.preventDefault();
		openExternal(url);
	});
	splash.once("ready-to-show", () => {
		splashShownAt = Date.now();
		splash?.showInactive();
	});
	splash.on("closed", () => {
		splash = null;
		splashHold = false;
	});
	const joined = fs.existsSync(earlyAccessMarker()) ? "1" : "0";
	splash.loadFile(path.join(root, "electron", "splash", "splash.html"), { query: { version: appVersion, joined, store: process.mas ? "mas" : "" } });
}

/**
 * Swaps the splash for the main window once the app is ready and the splash has had its time
 */
function finishSplash() {
	if (!appReady || !mainWindow) return;
	if (splash) {
		const remaining = SPLASH_MIN_MS - (Date.now() - splashShownAt);
		if (remaining > 0) {
			setTimeout(finishSplash, remaining);
			return;
		}
		if (splashHold) {
			setTimeout(finishSplash, 250);
			return;
		}
	}
	if (!mainWindow.isVisible()) mainWindow.show();
	splash?.close();
}

function createWindow({ show = true } = {}) {
	mainWindow = new BrowserWindow({
		show,
		// Matches the page background so a dark theme doesn't flash white while loading
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#161618" : "#ffffff",
		width: 1400,
		height: 900,
		minWidth: 900,
		minHeight: 600,
		title: "PSQLCarbon",
		// macOS: no native title bar, the traffic lights sit in the app's own (app/components/title-bar.tsx),
		// which also moves the window (data-titlebar="mac" in app/root.tsx and .app-drag in app/tailwind.scss)
		...(process.platform === "darwin" ? { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: 13 } } : {}),
		// Windows and Linux show this in the taskbar, macOS uses the app bundle's icon
		icon: path.join(root, "electron", "resources", "icon.png"),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
		},
	});

	// External links open in the browser, the window only shows the local app
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		openExternal(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("will-navigate", (event, url) => {
		if (!url.startsWith(origin)) {
			event.preventDefault();
			openExternal(url);
		}
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});

	mainWindow.once("ready-to-show", () => {
		appReady = true;
		finishSplash();
	});

	mainWindow.loadURL(origin);
}

// Written once someone joins the early access list, from the splash or the app (app/lib/early-access.server.ts),
// the splash then stops showing its form
const earlyAccessMarker = () => path.join(app.getPath("userData"), "early-access-joined");

// The splash's early access form (electron/splash-preload.cjs), only the splash itself may call these
ipcMain.handle("splash:join-early-access", async (event, email) => {
	if (!splash || event.sender !== splash.webContents) return { ok: false, message: "Not available" };
	const result = await joinEarlyAccess(email, "splash");
	if (result.ok) fs.writeFileSync(earlyAccessMarker(), new Date().toISOString());
	return result;
});
ipcMain.on("splash:hold", (event, hold) => {
	if (splash && event.sender === splash.webContents) splashHold = hold === true;
});

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.focus();
		}
	});

	app.whenReady()
		.then(async () => {
			// A packaged app has its icon in the bundle, while developing the Dock would show Electron's
			if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(path.join(root, "electron", "resources", "icon.png"));
			createSplash();
			prepareEnv();
			await migrate();
			await startApp();
			createWindow({ show: false });

			app.on("activate", () => {
				if (BrowserWindow.getAllWindows().length === 0) createWindow();
			});
		})
		.catch((error) => {
			splash?.close();
			dialog.showErrorBox("PSQLCarbon failed to start", error?.stack || String(error));
			app.exit(1);
		});

	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
}
