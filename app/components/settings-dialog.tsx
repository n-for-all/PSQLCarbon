import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/tabs";
import { McpSettings, type McpInfo } from "~/components/mcp-settings";
import { Link, useFetcher } from "@remix-run/react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/ui/dialog";
import { AiSettingsForm } from "~/components/ai-settings-form";
import { toast } from "~/ui/hooks/use-toast";

// Sent on window to open the dialog from anywhere in the app (the AI panel's "configure" link),
// and by the dialog after a save so the AI panel shows the new model
export const OPEN_SETTINGS_EVENT = "psqlcarbon:open-settings";
export const SETTINGS_SAVED_EVENT = "psqlcarbon:settings-saved";

export const openSettings = () => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));

/**
 * The settings over the current page, so leaving them returns to it as it was: the open table, the query being
 * written and the AI chat all stay. Loads and saves through the /profile route without navigating to it.
 */
export const SettingsDialog = ({ open, onClose, desktop }: { open: boolean; onClose: () => void; desktop: boolean }) => {
    const data = useFetcher<{ user: any }>();
    const save = useFetcher<{ formError?: string; formSuccess?: string }>();

    // The MCP server is only in the downloadable desktop app (app/routes/api.mcp.ts)
    const [mcp, setMcp] = useState<McpInfo | null>(null);
    useEffect(() => {
        if (!open) return;
        data.load("/profile");
        if (desktop) {
            fetch("/api/mcp")
                .then((response) => (response.ok ? response.json() : null))
                .then(setMcp)
                .catch(() => setMcp(null));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (save.state !== "idle" || !save.data) return;
        if (save.data.formError) {
            toast({ title: "Error", description: save.data.formError, type: "background" });
        } else if (save.data.formSuccess) {
            toast({ title: save.data.formSuccess, type: "background" });
            data.load("/profile");
            window.dispatchEvent(new Event(SETTINGS_SAVED_EVENT));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [save.state, save.data]);

    const user = data.data?.user;

    const aiSettings = (
        <div className="flex flex-col min-w-0 gap-4">
            <DialogHeader>
                <DialogTitle>AI Assistant Settings</DialogTitle>
                <DialogDescription>Choose the AI the assistant uses: a hosted provider with an API key, or a model running on your machine.</DialogDescription>
            </DialogHeader>
            {user ? (
                <AiSettingsForm
                    key={JSON.stringify(user.aiProviders || []) + (user.openAiBaseUrl || "") + (user.openAiModel || "")}
                    baseUrl={user.openAiBaseUrl}
                    model={user.openAiModel}
                    providers={user.aiProviders || []}
                    form={save.Form}
                    action="/profile"
                />
            ) : (
                <div className="py-10 text-sm text-center text-neutral-500">{data.state === "idle" ? "Could not load the settings." : "Loading..."}</div>
            )}
        </div>
    );

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-xl grid-cols-1 overflow-x-hidden">
                {mcp?.available ? (
                    <Tabs defaultValue="ai" className="w-full min-w-0">
                        <TabsList className="grid grid-cols-2 mb-4 mr-8 w-[calc(100%-2rem)]">
                            <TabsTrigger value="ai">AI Assistant</TabsTrigger>
                            <TabsTrigger value="mcp">MCP Server</TabsTrigger>
                        </TabsList>
                        <TabsContent value="ai" className="min-w-0">{aiSettings}</TabsContent>
                        <TabsContent value="mcp" className="min-w-0">
                            <McpSettings info={mcp} onChange={setMcp} />
                        </TabsContent>
                    </Tabs>
                ) : (
                    aiSettings
                )}
                {!desktop && (
                    <div className="pt-3 text-xs border-t border-neutral-200 text-neutral-500">
                        Password and users:{" "}
                        <Link to="/profile" className="underline hover:text-neutral-900" onClick={onClose}>
                            account settings
                        </Link>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
};
