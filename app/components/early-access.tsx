import { useRouteLoaderData } from "@remix-run/react";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/popover";
import { Button } from "~/ui/button";
import { NativeInput } from "~/ui/input";
import { cn } from "~/ui/lib/utils";

// Remembered on this device so the button goes away once someone has joined
const JOINED_KEY = "pro_early_access";

/**
 * "Early access" button with a small sign up form, the email goes to the early access list (api.early-access.ts)
 */
export const EarlyAccess = ({ className }: { className?: string }) => {
    // The desktop app also knows about joining from the splash screen (lib/early-access.server.ts)
    const joinedOnDevice = useRouteLoaderData<{ earlyAccessJoined?: boolean }>("root")?.earlyAccessJoined;
    const [joined, setJoined] = useState(true);
    const [open, setOpen] = useState(false);
    const [email, setEmail] = useState("");
    const [state, setState] = useState<"idle" | "sending" | "done">("idle");
    const [error, setError] = useState("");

    useEffect(() => {
        try {
            setJoined(localStorage.getItem(JOINED_KEY) === "joined");
        } catch {
            setJoined(false);
        }
    }, []);

    if ((joined || joinedOnDevice) && state !== "done") return null;

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError("");
        setState("sending");
        try {
            const response = await fetch("/api/early-access", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email }),
            });
            const result = await response.json();
            if (result.status !== "success") throw new Error(result.message);
            setState("done");
            try {
                localStorage.setItem(JOINED_KEY, "joined");
            } catch {
                // Only means the button shows again next time
            }
        } catch (e: any) {
            setError(e.message || "The sign up didn't go through, please try again");
            setState("idle");
        }
    };

    return (
        <Popover
            open={open}
            onOpenChange={(value) => {
                setOpen(value);
                // After a successful sign up, closing the popover also removes the button
                if (!value && state === "done") setJoined(true);
            }}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        "flex items-center gap-1.5 h-7 px-2.5 text-[13px] font-medium rounded-md text-primary bg-primary/10 hover:bg-primary/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                        className
                    )}>
                    <Sparkles size={14} />
                    Early access
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="p-4 w-80">
                {state === "done" ? (
                    <div className="text-sm">
                        <div className="mb-1 font-semibold">You're on the list, thank you.</div>
                        <p className="text-neutral-600">We'll email you when new features are ready, before anyone else gets them.</p>
                    </div>
                ) : (
                    <form onSubmit={submit} className="flex flex-col gap-3">
                        <div>
                            <div className="text-sm font-semibold">Get early access to new features</div>
                            <p className="mt-1 text-xs text-neutral-600">Be the first to try what's next in PSQLCarbon, like AI that works without your own API key.</p>
                        </div>
                        <NativeInput
                            type="email"
                            required
                            autoFocus
                            placeholder="you@example.com"
                            aria-label="Email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="bg-white"
                        />
                        {error && <div className="text-xs text-red-600">{error}</div>}
                        <Button type="submit" size="sm" loading={state === "sending"} className="justify-center">
                            Join
                        </Button>
                        <p className="text-[11px] leading-snug text-neutral-500">
                            Only product news, unsubscribe anytime. See the{" "}
                            <a href="https://psqlcarbon.com/privacy" target="_blank" rel="noopener noreferrer" className="underline">
                                privacy policy
                            </a>
                            .
                        </p>
                    </form>
                )}
            </PopoverContent>
        </Popover>
    );
};
