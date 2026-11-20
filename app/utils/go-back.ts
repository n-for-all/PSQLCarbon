import { useNavigate } from "@remix-run/react";

/**
 * Back to the page the user came from (in the app, without reloading it), or to the dashboard when the page
 * was opened directly. Remix keeps the position in the app's history in history.state.idx.
 */
export function useGoBack(fallback = "/") {
    const navigate = useNavigate();
    return () => {
        const idx = typeof window !== "undefined" ? window.history.state?.idx : 0;
        if (typeof idx === "number" && idx > 0) navigate(-1);
        else navigate(fallback);
    };
}
