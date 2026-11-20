import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteLoaderData } from "@remix-run/react";
import type { LinksFunction, LoaderFunction } from "@remix-run/node";
import os from "node:os";
import { hasJoinedEarlyAccess } from "~/lib/early-access.server";
import { Toaster } from "~/ui/toaster";
import { ThemeProvider } from "next-themes";
import { PageLoadingBar } from "~/components/page-loading";

import "./tailwind.css";
import { ensureMcpServer } from "~/lib/mcp.server";

export const links: LinksFunction = () => [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&family=Geist:wght@100..900&display=swap" },
    {
        rel: "icon",
        type: "image/svg+xml",
        href: "/favicon.svg",
    },
];

export const loader: LoaderFunction = async () => {
    const desktop = process.env.PSQLCARBON_DESKTOP === "1";
    // The MCP server starts with the app when it's turned on, a no-op once it runs (app/lib/mcp.server.ts)
    if (desktop) ensureMcpServer().catch((error) => console.error("The MCP server could not start", error));
    // The desktop app runs on the same machine as this server, so its platform is the server's.
    // The system is only shared there, for bug reports, a web server's isn't the visitor's business.
    const system = desktop ? `${{ darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] || process.platform} (${os.type()} ${os.release()}, ${process.arch})` : null;
    return Response.json({
        desktop,
        macTitlebar: desktop && process.platform === "darwin",
        appStore: process.env.PSQLCARBON_APP_STORE === "1",
        system,
        earlyAccessJoined: hasJoinedEarlyAccess(),
    });
};

export function Layout({ children }: { children: React.ReactNode }) {
    const macTitlebar = useRouteLoaderData<{ macTitlebar?: boolean }>("root")?.macTitlebar;
    return (
        // next-themes sets the theme class on <html> before React hydrates, so the title bar is a data attribute
        <html lang="en" suppressHydrationWarning data-titlebar={macTitlebar ? "mac" : undefined}>
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <Meta />
                <Links />
            </head>
            <body>
                <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
                    {children}
                    <Toaster />
                </ThemeProvider>
                <ScrollRestoration />
                <Scripts />
            </body>
        </html>
    );
}

export default function App() {
    return (
        <>
            <PageLoadingBar />
            <Outlet />
        </>
    );
}
