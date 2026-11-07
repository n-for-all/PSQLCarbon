import { useNavigation } from "@remix-run/react";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "~/ui/lib/utils";

// Fired by loadPage(), a full page load doesn't go through Remix so useNavigation() can't see it
const FULL_LOAD_EVENT = "psqlcarbon:page-load";

/**
 * Loads a page with a full reload (for example after switching connections) and shows the loading screen meanwhile
 */
export function loadPage(url: string) {
	window.dispatchEvent(new Event(FULL_LOAD_EVENT));
	window.location.href = url;
}

/**
 * The page being opened while one is loading, or null when nothing is loading
 */
function usePendingPage() {
	const navigation = useNavigation();
	const [fullLoad, setFullLoad] = useState<string | null>(null);

	useEffect(() => {
		const onLoad = () => setFullLoad("");
		// Coming back through the browser cache shows the old page again
		const onShow = () => setFullLoad(null);
		window.addEventListener(FULL_LOAD_EVENT, onLoad);
		window.addEventListener("pageshow", onShow);
		return () => {
			window.removeEventListener(FULL_LOAD_EVENT, onLoad);
			window.removeEventListener("pageshow", onShow);
		};
	}, []);

	if (navigation.state === "loading" && navigation.location) return navigation.location.pathname;
	return fullLoad;
}

/**
 * Thin bar along the top of the window while a page loads, it shows right away so every click gets an answer
 */
export function PageLoadingBar() {
	const pending = usePendingPage();
	if (pending === null) return null;
	return (
		<div className="fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden pointer-events-none" role="progressbar" aria-label="Loading">
			<div className="h-full w-1/3 bg-primary page-loading-bar" />
		</div>
	);
}

/**
 * Covers the content while the next page loads, so a slow database doesn't make the app look stuck.
 * It waits a moment before showing, fast pages never flash it. Place it in a positioned container.
 */
export function PageLoadingOverlay({ className }: { className?: string }) {
	const pending = usePendingPage();
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		if (pending === null) {
			setVisible(false);
			return;
		}
		const timer = setTimeout(() => setVisible(true), 250);
		return () => clearTimeout(timer);
	}, [pending]);

	if (pending === null || !visible) return null;
	// "/database/shop/orders" -> "orders"
	const name = decodeURIComponent(pending.split("/").filter(Boolean).pop() || "");
	return (
		<div className={cn("absolute inset-0 z-40 flex items-center justify-center bg-white/70 backdrop-blur-[1px]", className)} aria-live="polite">
			<div className="flex items-center gap-3 px-4 py-3 text-sm bg-white border shadow-sm border-neutral-200 text-neutral-600">
				<Loader2 className="w-4 h-4 animate-spin" />
				{name ? `Loading ${name}…` : "Loading…"}
			</div>
		</div>
	);
}
