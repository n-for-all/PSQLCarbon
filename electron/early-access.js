// Adds an email to the PSQLCarbon Pro early access list from the splash screen. The app's pages use
// app/routes/api.early-access.ts, which does the same through the app server.

// The "PSQLCarbon Subscriber" form on nextmark.ae, which keeps the early access list
const FORM_PAGE = "https://nextmark.ae/form/nextmark/5?locale=en";
const FORM_SUBMIT = "https://nextmark.ae/form/nextmark/5/en";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The form hands out a fresh key, timestamp and session with each page load, so the page is read first
 * and the form then posted like a browser would. Resolves to { ok, message }.
 */
export async function joinEarlyAccess(email, medium) {
	if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email.trim())) {
		return { ok: false, message: "Please enter a valid email address" };
	}
	try {
		const page = await fetch(FORM_PAGE, { signal: AbortSignal.timeout(15000) });
		const html = await page.text();
		const hidden = (name) => new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? "";
		const cookie = page.headers.get("set-cookie")?.split(";")[0];

		const form = new FormData();
		form.set("field_1", email.trim());
		// Left empty, it's the form's trap for bots
		form.set("field_2", "");
		form.set("key", hidden("key"));
		form.set("timestamp", hidden("timestamp"));
		form.set("utm_source", "psqlcarbon-app");
		form.set("utm_medium", medium);
		form.set("utm_campaign", "pro-early-access");

		const response = await fetch(FORM_SUBMIT, {
			method: "POST",
			headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) },
			body: form,
			signal: AbortSignal.timeout(15000),
		});
		const result = await response.json();
		if (result.status === "success") return { ok: true };
		const fieldError = Array.isArray(result.error) ? result.error.find((e) => e?.message)?.message : null;
		return { ok: false, message: fieldError || result.message || "The sign up didn't go through, please try again" };
	} catch {
		return { ok: false, message: "Couldn't reach the sign up service, check your internet connection" };
	}
}
