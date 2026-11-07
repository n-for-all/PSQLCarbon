import { ActionFunction } from "@remix-run/node";
import { requireUser } from "~/utils/session.server";
import { rememberEarlyAccessJoined } from "~/lib/early-access.server";

// The "PSQLCarbon Subscriber" form on nextmark.ae, which keeps the early access list
const FORM_PAGE = "https://nextmark.ae/form/nextmark/5?locale=en";
const FORM_SUBMIT = "https://nextmark.ae/form/nextmark/5/en";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Adds an email to the PSQLCarbon Pro early access list. The form hands out a fresh key, timestamp and session
 * with each page load, so the page is read first and the form then posted like a browser would.
 */
export const action: ActionFunction = async ({ request }) => {
    await requireUser(request, "/login");
    const { email } = await request.json().catch(() => ({}));
    if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email.trim())) {
        return Response.json({ status: "error", message: "Please enter a valid email address" }, { status: 400 });
    }

    try {
        const page = await fetch(FORM_PAGE, { signal: AbortSignal.timeout(15000) });
        const html = await page.text();
        const hidden = (name: string) => new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? "";
        const cookie = page.headers.get("set-cookie")?.split(";")[0];

        const form = new FormData();
        form.set("field_1", email.trim());
        // Left empty, it's the form's trap for bots
        form.set("field_2", "");
        form.set("key", hidden("key"));
        form.set("timestamp", hidden("timestamp"));
        form.set("utm_source", "psqlcarbon-app");
        form.set("utm_medium", process.env.PSQLCARBON_DESKTOP === "1" ? "desktop" : "web");
        form.set("utm_campaign", "pro-early-access");

        const response = await fetch(FORM_SUBMIT, {
            method: "POST",
            headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
            body: form,
            signal: AbortSignal.timeout(15000),
        });
        const result = await response.json();
        if (result.status === "success") {
            rememberEarlyAccessJoined();
            return Response.json({ status: "success" });
        }
        const fieldError = Array.isArray(result.error) ? result.error.find((e: any) => e?.message)?.message : null;
        return Response.json({ status: "error", message: fieldError || result.message || "The sign up didn't go through, please try again" }, { status: 400 });
    } catch {
        return Response.json({ status: "error", message: "Couldn't reach the sign up service, check your internet connection and try again" }, { status: 502 });
    }
};
