#!/usr/bin/env node
// Downloads pg_dump and pg_restore for the desktop app into electron/pg-tools/<target>/, with only the
// libraries they load. Builds come from https://github.com/theseus-rs/postgresql-binaries (PostgreSQL license),
// every download is checked against its published SHA-256.
//
//   node scripts/fetch-pg-tools.mjs              this machine's platform and architecture
//   node scripts/fetch-pg-tools.mjs --all        every target the desktop app is built for
//   node scripts/fetch-pg-tools.mjs mac-x64 ...  specific targets
//
// A newer pg_dump can back up older servers, so this should be the newest PostgreSQL release.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "18.6.1";
const TARGETS = {
	"mac-arm64": "aarch64-apple-darwin",
	"mac-x64": "x86_64-apple-darwin",
	"linux-x64": "x86_64-unknown-linux-gnu",
	"linux-arm64": "aarch64-unknown-linux-gnu",
	"win-x64": "x86_64-pc-windows-msvc",
};
const TOOLS = ["pg_dump", "pg_restore"];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "electron", "pg-tools");

const currentTarget = () => `${{ darwin: "mac", win32: "win", linux: "linux" }[process.platform]}-${process.arch}`;

async function download(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
	return Buffer.from(await response.arrayBuffer());
}

// Shared libraries a binary loads, by file name
function machoDependencies(file) {
	return execFileSync("otool", ["-L", file], { encoding: "utf8" })
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(" ")[0])
		.filter((name) => name.startsWith("@loader_path/") || name.startsWith("@rpath/"))
		.map((name) => path.basename(name));
}

function elfDependencies(file) {
	const d = fs.readFileSync(file);
	const shoff = Number(d.readBigUInt64LE(0x28));
	const shentsize = d.readUInt16LE(0x3a);
	const shnum = d.readUInt16LE(0x3c);
	const sections = Array.from({ length: shnum }, (_, i) => {
		const o = shoff + i * shentsize;
		return { type: d.readUInt32LE(o + 4), offset: Number(d.readBigUInt64LE(o + 0x18)), size: Number(d.readBigUInt64LE(o + 0x20)), link: d.readUInt32LE(o + 0x28) };
	});
	const dynamic = sections.find((section) => section.type === 6);
	if (!dynamic) return [];
	const strings = sections[dynamic.link];
	const names = [];
	for (let o = dynamic.offset; o < dynamic.offset + dynamic.size; o += 16) {
		const tag = Number(d.readBigInt64LE(o));
		if (tag === 0) break;
		if (tag === 1) {
			const start = strings.offset + Number(d.readBigUInt64LE(o + 8));
			names.push(d.toString("utf8", start, d.indexOf(0, start)));
		}
	}
	return names;
}

// Import table names of a PE file, read as strings: a name that isn't in the archive is simply not copied
function peDependencies(file) {
	return [...new Set(fs.readFileSync(file).toString("latin1").match(/[A-Za-z0-9_.-]+\.dll/gi) || [])];
}

function copyTarget(source, out, target) {
	const isWindows = target.startsWith("win");
	const isMac = target.startsWith("mac");
	if (isMac && process.platform !== "darwin") throw new Error("macOS tools can only be prepared on macOS (otool is needed)");
	const exe = (name) => (isWindows ? `${name}.exe` : name);
	// Windows keeps DLLs next to the programs, macOS and Linux in lib/ found through @loader_path/../lib or $ORIGIN/../lib
	const libSource = path.join(source, isWindows ? "bin" : "lib");
	const libOut = path.join(out, isWindows ? "bin" : "lib");
	fs.mkdirSync(path.join(out, "bin"), { recursive: true });
	fs.mkdirSync(libOut, { recursive: true });

	const queue = [];
	for (const tool of TOOLS) {
		const file = path.join(source, "bin", exe(tool));
		fs.copyFileSync(file, path.join(out, "bin", exe(tool)));
		queue.push(file);
	}
	const copied = new Set();
	while (queue.length) {
		const file = queue.shift();
		const dependencies = isMac ? machoDependencies(file) : isWindows ? peDependencies(file) : elfDependencies(file);
		for (const name of dependencies) {
			const library = path.join(libSource, name);
			if (copied.has(name) || !fs.existsSync(library)) continue;
			copied.add(name);
			// Copy the file itself, Linux names are often symlinks to the versioned file
			fs.copyFileSync(fs.realpathSync(library), path.join(libOut, name));
			queue.push(library);
		}
	}

	// The licenses. The "NOTICEREF" files are copies of OpenSSL manual pages that differ by build date between
	// architectures, and the universal macOS build needs every non binary file to be identical in both
	for (const notice of ["COPYRIGHT", "LICENSE", "dependency-notices"]) {
		const from = path.join(source, notice);
		if (fs.existsSync(from)) fs.cpSync(from, path.join(out, notice), { recursive: true, filter: (file) => !/NOTICEREF/.test(path.basename(file)) });
	}
	const platform = isMac ? "macOS" : TARGETS[target];
	fs.writeFileSync(path.join(out, "VERSION"), `PostgreSQL ${VERSION} client tools (${platform}) from theseus-rs/postgresql-binaries\n`);
	return [...copied];
}

async function prepare(target) {
	const triple = TARGETS[target];
	if (!triple) throw new Error(`Unknown target ${target}, use one of ${Object.keys(TARGETS).join(", ")}`);
	const out = path.join(outRoot, target);
	if (fs.existsSync(path.join(out, "VERSION")) && fs.readFileSync(path.join(out, "VERSION"), "utf8").includes(`PostgreSQL ${VERSION} `)) {
		console.log(`${target}: PostgreSQL ${VERSION} already prepared`);
		return;
	}

	const name = `postgresql-${VERSION}-${triple}.tar.gz`;
	const base = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${VERSION}`;
	console.log(`${target}: downloading ${name}`);
	const [archive, checksum] = await Promise.all([download(`${base}/${name}`), download(`${base}/${name}.sha256`)]);
	const expected = checksum.toString("utf8").trim().split(/\s+/)[0];
	const actual = createHash("sha256").update(archive).digest("hex");
	if (actual !== expected) throw new Error(`${name}: checksum mismatch, expected ${expected}, got ${actual}`);

	const work = fs.mkdtempSync(path.join(os.tmpdir(), "psqlcarbon-pg-"));
	try {
		fs.writeFileSync(path.join(work, name), archive);
		execFileSync("tar", ["-xzf", name], { cwd: work });
		const source = path.join(work, `postgresql-${VERSION}-${triple}`);
		fs.rmSync(out, { recursive: true, force: true });
		const libraries = copyTarget(source, out, target);
		console.log(`${target}: ${TOOLS.join(", ")} with ${libraries.join(", ")}`);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

const args = process.argv.slice(2);
const targets = args.includes("--all") ? Object.keys(TARGETS).filter((t) => process.platform === "darwin" || !t.startsWith("mac")) : args.length ? args : [currentTarget()];
for (const target of targets) await prepare(target);
