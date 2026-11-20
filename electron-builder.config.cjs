// Packaging config for the desktop app (electron-builder). It's JavaScript rather than YAML because the
// generated Prisma client lives in a pnpm folder whose name depends on the installed version.
const path = require("node:path");

// The generated client sits next to @prisma/client inside node_modules/.pnpm, which electron-builder doesn't pick up
const prismaClient = path.dirname(require.resolve("@prisma/client/package.json", { paths: [__dirname] }));
const generatedPrisma = path.join(prismaClient, "..", "..", ".prisma");

// pg_dump and pg_restore for each platform, run "pnpm pg-tools" (or --all) before packaging
const pgTools = (platform) => [{ from: `electron/pg-tools/${platform}-\${arch}`, to: "pg-tools" }];

/** @type {import("electron-builder").Configuration} */
module.exports = {
	appId: "com.psqlcarbon.app",
	productName: "PSQLCarbon",
	copyright: "Copyright © 2026 Naji Amer",
	// CFBundleVersion: each upload of the same version to App Store Connect needs a higher one
	buildVersion: "1.0.3",
	directories: { output: "dist-electron" },
	// package.json has no "main" so npm leaves electron/ out of the web package, the desktop app gets it here
	extraMetadata: { main: "electron/main.js" },
	// One archive instead of ~20,000 loose files: faster to sign, merge into a universal app and start.
	// Native files can't be loaded from inside an archive, so they're kept next to it.
	asar: true,
	// Native files, and the MCP bridge that Claude Desktop runs with the app as plain Node (electron/mcp-bridge.cjs)
	asarUnpack: ["**/*.node", "electron/mcp-bridge.cjs"],
	files: [
		"package.json",
		"electron/**",
		// Bundled per platform through extraResources below
		"!electron/pg-tools/**",
		"build/**",
		"prisma/schema.prisma",
		"prisma/migrations/**",
		"!**/*.map",
		// Only needed to generate the client and run migrations from the CLI, the app migrates itself (electron/main.js)
		"!node_modules/prisma/**",
		"!node_modules/@prisma/engines/**",
		{ from: generatedPrisma, to: "node_modules/.prisma", filter: ["**/*"] },
	],
	// Both macOS builds have the same features: the desktop app only uses what the App Store sandbox allows
	mac: {
		icon: "electron/resources/icon.icns",
		category: "public.app-category.developer-tools",
		minimumSystemVersion: "12.0",
		extraResources: pgTools("mac"),
		// Notarized download: signed with "Developer ID Application", notarized with the keychain profile in
		// APPLE_KEYCHAIN_PROFILE (or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID)
		hardenedRuntime: true,
		gatekeeperAssess: false,
		entitlements: "electron/entitlements/mac.plist",
		entitlementsInherit: "electron/entitlements/mac.plist",
		extendInfo: {
			// Only standard TLS is used, which is exempt from export compliance
			ITSAppUsesNonExemptEncryption: false,
		},
		target: [{ target: "dmg", arch: ["arm64", "x64"] }],
	},
	// No version in the name, so the website can link to releases/latest/download/PSQLCarbon-<arch>.dmg
	dmg: {
		artifactName: "${productName}-${arch}.${ext}",
	},
	// Mac App Store: signed with "Apple Distribution" and "3rd Party Mac Developer Installer", sandboxed
	mas: {
		entitlements: "electron/entitlements/mas.plist",
		entitlementsInherit: "electron/entitlements/mas.inherit.plist",
		// Kept with the signing files in certificates/, which git ignores
		provisioningProfile: "certificates/PSQLCarbon.provisionprofile",
		hardenedRuntime: false,
		target: [{ target: "mas", arch: "universal" }],
		// The build number is in the name so uploads to App Store Connect can't be mixed up
		artifactName: "${productName}-${version}-build${buildVersion}-${arch}.${ext}",
		// Both copies carry the Apple silicon and the Intel Prisma engine, so they stay as they are in the universal app
		x64ArchFiles: "Contents/Resources/app.asar.unpacked/node_modules/.prisma/client/libquery_engine-*.dylib.node",
	},
	win: {
		icon: "electron/resources/icon.png",
		target: "nsis",
		extraResources: pgTools("win"),
	},
	linux: {
		icon: "electron/resources/icon.png",
		target: "AppImage",
		category: "Development",
		extraResources: pgTools("linux"),
	},
};
