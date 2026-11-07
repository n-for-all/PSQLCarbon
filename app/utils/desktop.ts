import { useRouteLoaderData } from "@remix-run/react";

/**
 * True when running inside the desktop app, where there is no login/logout
 */
export function useIsDesktop() {
	return Boolean(useRouteLoaderData<{ desktop?: boolean }>("root")?.desktop);
}

/**
 * True in the macOS desktop app, whose window has no title bar: headers leave room for the traffic lights
 */
export function useMacTitlebar() {
	return Boolean(useRouteLoaderData<{ macTitlebar?: boolean }>("root")?.macTitlebar);
}
