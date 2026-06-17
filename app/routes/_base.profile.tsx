import { ArrowRightIcon, PlusIcon, VersionsIcon, ArrowLeftIcon } from "@primer/octicons-react";
import { ActionFunction, LoaderFunction, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigate } from "@remix-run/react";
import { useEffect, useState } from "react";
import ActionableNotification from "~/ui/actionable-notification";
import { Button } from "~/ui/button";
import { Input } from "~/ui/input";
import { validatePassword } from "~/utils/functions";
import { logout, requireUser, updatePassword } from "~/utils/session.server";
import { userDb } from "~/utils/db.server";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/ui/tabs";

export const loader: LoaderFunction = async ({ request }) => {
    const user = await requireUser(request, "/login?redirect=/profile");

    return Response.json(
        { user },
        {
            headers: {
                "Cache-Control": "no-store",
            },
        }
    );
};
export const action: ActionFunction = async ({ request }) => {
    const user = await requireUser(request, "/login?redirect=/profile");
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "update_ai_settings") {
        const openAiApiKey = formData.get("openAiApiKey") as string;
        const openAiBaseUrl = formData.get("openAiBaseUrl") as string;
        const openAiModel = formData.get("openAiModel") as string;

        try {
            await userDb.user.update({
                where: { id: user.id },
                data: { openAiApiKey, openAiBaseUrl, openAiModel },
            });
            return Response.json({ formSuccess: "AI settings updated successfully!" });
        } catch (e: any) {
            return Response.json({ formError: e.message });
        }
    }

    if (intent === "update_password") {
        const password = formData.get("password");
        const confirm_password = formData.get("confirm_password");
        if (typeof password !== "string" || typeof confirm_password !== "string") {
            return Response.json({
                formError: `Please enter a valid password.`,
            });
        }
        const fields = { password, confirm_password };
        const fieldErrors = {
            password: validatePassword(password),
        };
        if (Object.values(fieldErrors).some(Boolean)) {
            return Response.json({ fieldErrors, fields, formError: validatePassword(password) });
        }

        if (password !== confirm_password) {
            return Response.json({
                fields,
                formError: `Passwords do not match.`,
                fieldErrors: {
                    confirm_password: "Confirm password do not match.",
                },
            });
        }

        try {
            await updatePassword(user.id, password);
            await logout(request);
            return redirect("/");
        } catch (e: any) {
            return Response.json({
                fields,
                formError: e.message,
            });
        }
    }

    return null;
};

export default function Dashboard() {
    const loaderData = useLoaderData<typeof loader>();
    const user = loaderData?.user;
    const navigate = useNavigate();

    const [state, setState] = useState({
        password: "",
        confirm_password: "",
    });

    const actionData = useActionData<typeof action>();
    // const [searchParams] = useSearchParams();
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (actionData && (actionData.formError || actionData.formSuccess)) {
            setOpen(true);
        }
        if (actionData && actionData.fields) {
            setState(actionData.fields);
        }
    }, [actionData]);

    return (
        <>
            <div className="w-full max-w-md mx-auto my-16">
                <div className="mb-4">
                    <Button variant="ghost" size="sm" icon={<ArrowLeftIcon />} onClick={() => navigate("/")}>
                        Back to Homepage
                    </Button>
                </div>

                <div className="bg-white border border-solid border-neutral-200 p-6">
                    <Tabs defaultValue="profile" className="w-full">
                        <TabsList className="grid w-full grid-cols-2 mb-6">
                            <TabsTrigger value="profile">Profile</TabsTrigger>
                            <TabsTrigger value="ai">AI Settings</TabsTrigger>
                        </TabsList>

                        <TabsContent value="profile">
                            <h2 className="mb-2 text-2xl font-bold">Welcome</h2>
                            <p className="mb-6 text-sm">Please use the form below to update your profile</p>
                            <Form method="post">
                                <div className="flex flex-col gap-5 mb-2">
                                    <Input id="username" name="username" readOnly labelText="Username" type="text" value={user.username} autoComplete="new-password" required />
                                    <Input
                                        id="password"
                                        name="password"
                                        labelText="Password"
                                        type="password"
                                        value={state.password}
                                        onChange={(e) => {
                                            setState({ ...state, password: e.target.value });
                                        }}
                                        required
                                        autoComplete="new-password"
                                        invalid={Boolean(actionData?.fieldErrors?.password) || undefined}
                                        invalidText={actionData?.fieldErrors?.password ? actionData?.fieldErrors?.password : undefined}
                                    />
                                    <Input
                                        id="confirm_password"
                                        name="confirm_password"
                                        labelText="Confirm Password"
                                        type="password"
                                        value={state.confirm_password}
                                        onChange={(e) => {
                                            setState({ ...state, confirm_password: e.target.value });
                                        }}
                                        required
                                        autoComplete="new-password"
                                        invalid={Boolean(actionData?.fieldErrors?.confirm_password) || undefined}
                                        invalidText={actionData?.fieldErrors?.confirm_password ? actionData?.fieldErrors?.confirm_password : undefined}
                                    />
                                    <input type="hidden" name="intent" value="update_password" />
                                    <Button size="sm" icon={<ArrowRightIcon />} type="submit">
                                        Update Password
                                    </Button>
                                </div>
                            </Form>
                            <hr className="my-6" />
                            <div className="flex items-center justify-between">
                                <Button
                                    size="sm"
                                    icon={<PlusIcon />}
                                    type="button"
                                    variant={"secondary"}
                                    onClick={() => {
                                        navigate("/create");
                                    }}>
                                    Add User
                                </Button>
                                <Button
                                    hasIconOnly
                                    size="sm"
                                    icon={<VersionsIcon />}
                                    type="button"
                                    variant={"ghost"}
                                    onClick={() => {
                                        navigate("/connections");
                                    }}>
                                    Go to Connections
                                </Button>
                            </div>
                        </TabsContent>

                        <TabsContent value="ai">
                            <h2 className="mb-2 text-2xl font-bold">AI Assistant Settings</h2>
                            <p className="mb-6 text-sm">Configure your OpenAI compatible endpoint for the SQL Chat Assistant.</p>
                            <Form method="post" autoComplete="off" key={(user?.openAiBaseUrl || "ai") + (user?.openAiApiKey || "key") + (user?.openAiModel || "model")}>
                                <input type="hidden" name="intent" value="update_ai_settings" />
                                <div className="flex flex-col gap-5 mb-2">
                                    <Input
                                        id="openAiBaseUrl"
                                        name="openAiBaseUrl"
                                        labelText="API Base URL (e.g. https://api.openai.com/v1)"
                                        type="text"
                                        autoComplete="off"
                                        defaultValue={user?.openAiBaseUrl || ""}
                                        placeholder="https://api.openai.com/v1"
                                    />
                                    <Input
                                        id="openAiApiKey"
                                        name="openAiApiKey"
                                        labelText="API Key"
                                        autoComplete="new-password"
                                        type="password"
                                        defaultValue={user?.openAiApiKey || ""}
                                        placeholder="sk-..."
                                    />
                                    <Input
                                        id="openAiModel"
                                        name="openAiModel"
                                        labelText="Model Name"
                                        type="text"
                                        defaultValue={user?.openAiModel || "gpt-4o"}
                                        placeholder="gpt-4o"
                                    />
                                    <Button size="sm" icon={<ArrowRightIcon />} type="submit">
                                        Update AI Settings
                                    </Button>
                                </div>
                            </Form>
                        </TabsContent>
                    </Tabs>
                </div>
            </div>
            {open && actionData?.formError && (
                <div className="fixed -translate-x-1/2 left-1/2 bottom-10">
                    <ActionableNotification variant="error" title="Error" subtitle={actionData?.formError} closeOnEscape inline={false} onClose={() => setOpen(false)} />
                </div>
            )}
            {open && actionData?.formSuccess && (
                <div className="fixed -translate-x-1/2 left-1/2 bottom-10">
                    <ActionableNotification variant="success" title="Success" subtitle={actionData?.formSuccess} closeOnEscape inline={false} onClose={() => setOpen(false)} />
                </div>
            )}
        </>
    );
}
