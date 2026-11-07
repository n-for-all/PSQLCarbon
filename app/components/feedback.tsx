import { useRouteLoaderData } from "@remix-run/react";
import { useEffect, useState } from "react";
import packageJson from "../../package.json";
import Modal from "~/ui/modal";
import { Input } from "~/ui/input";
import { Textarea } from "~/ui/textarea";
import { cn } from "~/ui/lib/utils";

const NEW_ISSUE = "https://github.com/n-for-all/psqlcarbon/issues/new";
const TYPES = ["Bug", "Idea", "Question"] as const;
type FeedbackType = (typeof TYPES)[number];

const PLACEHOLDERS: Record<FeedbackType, string> = {
    Bug: "What happened, and what did you expect? Steps to reproduce it help a lot.",
    Idea: "What would you like PSQLCarbon to do?",
    Question: "What would you like to know?",
};

/**
 * Feedback goes to GitHub issues: this prepares one and opens it in the browser, where it's reviewed and sent
 * from the user's own GitHub account. Nothing is sent from the app itself.
 */
export const FeedbackDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
    const system = useRouteLoaderData<{ system?: string | null }>("root")?.system;
    const [type, setType] = useState<FeedbackType>("Bug");
    const [title, setTitle] = useState("");
    const [details, setDetails] = useState("");
    const [includeSystem, setIncludeSystem] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        if (open) setError("");
    }, [open]);

    const environment = `PSQLCarbon ${packageJson.version} (${system ? `desktop app, ${system}` : "web"})`;

    const submit = () => {
        if (!title.trim()) {
            setError("Please add a short title");
            return;
        }
        const body = [details.trim() || "_No details given_", "", "---", includeSystem ? environment : null, "_Sent from the Feedback button in PSQLCarbon_"]
            .filter((line) => line !== null)
            .join("\n");
        const url = `${NEW_ISSUE}?${new URLSearchParams({ title: `[${type}] ${title.trim()}`, body })}`;
        // The desktop app opens new windows in the default browser (electron/main.js)
        window.open(url, "_blank", "noopener");
        setTitle("");
        setDetails("");
        onClose();
    };

    return (
        <Modal
            open={open}
            onClose={onClose}
            closeOnEscape
            modalLabel="Feedback"
            modalHeading="Send feedback"
            primaryButtonText="Continue on GitHub"
            secondaryButtonText="Cancel"
            onPrimaryClick={submit}>
            <div className="flex flex-col gap-4">
                <div className="flex gap-1 p-1 bg-neutral-200/60 w-fit" role="radiogroup" aria-label="Type of feedback">
                    {TYPES.map((option) => (
                        <button
                            key={option}
                            type="button"
                            role="radio"
                            aria-checked={type === option}
                            onClick={() => setType(option)}
                            className={cn("px-3 py-1 text-sm", type === option ? "bg-white shadow-sm text-neutral-900" : "text-neutral-500 hover:text-neutral-900")}>
                            {option}
                        </button>
                    ))}
                </div>
                <Input
                    id="feedback-title"
                    labelText="Title"
                    value={title}
                    maxLength={120}
                    autoFocus
                    invalidText={error}
                    onChange={(e) => {
                        setTitle(e.target.value);
                        setError("");
                    }}
                />
                <div className="flex flex-col gap-2">
                    <label htmlFor="feedback-details" className="text-sm tracking-wide">
                        Details
                    </label>
                    <Textarea id="feedback-details" rows={6} value={details} placeholder={PLACEHOLDERS[type]} onChange={(e) => setDetails(e.target.value)} className="bg-white" />
                </div>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input type="checkbox" className="mt-1" checked={includeSystem} onChange={(e) => setIncludeSystem(e.target.checked)} />
                    <span>
                        Include the app version and system
                        <span className="block text-xs text-neutral-500">{environment}</span>
                    </span>
                </label>
                <p className="text-xs text-neutral-500">
                    This opens a new issue on GitHub in your browser, where you can review it before sending. Issues are public, so leave out passwords and private data.
                </p>
            </div>
        </Modal>
    );
};
