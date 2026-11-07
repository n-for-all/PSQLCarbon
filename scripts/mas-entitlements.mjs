#!/usr/bin/env node
// Writes electron/entitlements/mas.plist for the Mac App Store build: the application group needs the
// Apple team ID and the app ID. Team ID: APPLE_TEAM_ID or the default below, app ID from electron-builder.config.cjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const teamId = process.env.APPLE_TEAM_ID || "Z2FC9Z8TY6";
const { createRequire } = await import("node:module");
const appId = createRequire(import.meta.url)(path.join(root, "electron-builder.config.cjs")).appId;
if (!appId) throw new Error("appId not found in electron-builder.config.cjs");

const template = fs.readFileSync(path.join(root, "electron/entitlements/mas.template.plist"), "utf8");
fs.writeFileSync(path.join(root, "electron/entitlements/mas.plist"), template.replace("TEAM_ID.APP_ID", `${teamId}.${appId}`));
console.log(`mas.plist: application group ${teamId}.${appId}`);
