import { useActionData, useLoaderData, Form } from "@remix-run/react";
import { ActionFunction, LoaderFunction, TypedResponse } from "@remix-run/node";
import { validatePassword, validateUsername } from "~/utils/functions";
import { checkUserSession, createUserSession, isDesktop, login, register } from "~/utils/session.server";
import { randomBytes } from "node:crypto";
import { userDb } from "~/utils/db.server";
import { Button } from "@ui/button";
import React, { useEffect } from "react";
import { Logo } from "~/components/logo";
import { ArrowRightIcon } from "@primer/octicons-react";
import { Input } from "~/ui/input";
import { useToast } from "~/ui/hooks/use-toast";
import { ToastAction } from "~/ui/toast";
import GitHubWidget from "~/components/github_widget";
import packageJson from "../../package.json";

type ActionResponse = {
    status: string;
    message?: string;
    errors?: {
        username: string | undefined;
        password: string | undefined;
    };
};

// The first account is created from the login page, this is how the desktop app (and fresh installs) get an admin user
const needsSetup = async () => (await userDb.user.count()) === 0;

export const loader: LoaderFunction = async ({ request }) => {
    if (isDesktop()) {
        // Sign in to the single local account, it is created on first launch with a random password nobody needs to know
        const user = (await userDb.user.findFirst({ orderBy: { createdAt: "asc" } })) ?? (await register({ username: "local", password: randomBytes(24).toString("hex") }));
        const redirectTo = new URL(request.url).searchParams.get("redirectTo") || "/";
        return createUserSession(user.id, redirectTo.startsWith("/") && !redirectTo.startsWith("//") ? redirectTo : "/");
    }
    return Response.json({ setup: await needsSetup() });
};

export const action: ActionFunction = async ({ request }): Promise<TypedResponse<ActionResponse>> => {
    try {
        const form = await request.formData();
        const username = form.get("username");
        const password = form.get("password");
        const redirectTo = form.get("redirectTo") || "/";
        if (typeof username !== "string" || typeof password !== "string" || typeof redirectTo !== "string") {
            return Response.json({
                status: "error",
                message: `The Username and Password combination is incorrect`,
            });
        }

        if (form.get("intent") === "setup") {
            if (!(await needsSetup())) {
                return Response.json({ status: "error", message: "An admin account already exists, please login" });
            }
            const errors = {
                username: validateUsername(username),
                password: validatePassword(password),
            };
            if (Object.values(errors).some(Boolean)) {
                return Response.json({ status: "error", errors });
            }
            checkUserSession(request);
            const user = await register({ username, password });
            return createUserSession(user.id, "/connections");
        }

        const errors = {
            username: validateUsername(username),
            password: !password || password.trim() == "" ? "Please enter your password" : false,
        };
        if (Object.values(errors).some(Boolean)) {
            return Response.json({ status: "error", errors });
        }
        const user = await login({ username, password });
        if (!user) {
            return Response.json({
                status: "error",
                message: `The Username and Password combination is incorrect`,
            });
        }
        checkUserSession(request);
        return createUserSession(user.id, redirectTo);
    } catch (e: any) {
        if (e instanceof Response) {
            return e;
        }
        return Response.json({
            status: "error",
            message: e.message,
        });
    }
};

export default function LoginRoute() {
    const actionData = useActionData<ActionResponse>();
    const { setup } = useLoaderData<{ setup: boolean }>();

    const { toast } = useToast();
    useEffect(() => {
        if (actionData && actionData.message) {
            toast({
                variant: "error",
                title: actionData?.status == "error" ? "Error" : "Success",
                description: actionData?.message,
                action: <ToastAction altText="Close">Close</ToastAction>,
            });
        }
    }, [actionData]);
    return (
        <>
            <div className="flex items-center justify-center h-screen">
                <div className="w-full max-w-md mx-auto">
                    <Logo className={"h-10 mx-auto"} /> 
                    <div className="w-full p-10 mt-5 border border-solid bg-neutral-50 border-neutral-100">
                        <h3 className="block mb-1 text-3xl font-bold">{setup ? "Create admin account" : "Login"}</h3>
                        <small className="block mb-6 text-xs opacity-50 leading-1">
                            {setup ? "No users exist yet, choose the username and password for the admin account:" : "Please enter your username and password below:"}
                        </small>
                        {actionData?.status == "error" && actionData?.message && <div className="px-3 py-2 mb-4 text-sm text-red-600 border border-red-200 rounded bg-red-50">{actionData.message}</div>}
                        <Form method="post">
                            {setup && <input type="hidden" name="intent" value="setup" />}
                            <div className="flex flex-col gap-10">
                                <Input
                                    id="username"
                                    name="username"
                                    labelText="Username"
                                    type="text"
                                    autoComplete="new-password"
                                    required
                                    invalid={Boolean(actionData?.errors?.username) || undefined}
                                    invalidText={actionData?.errors?.username ? actionData?.errors?.username : undefined}
                                />
                                <Input
                                    id="password"
                                    name="password"
                                    labelText="Password"
                                    type="password"
                                    required
                                    autoComplete="new-password"
                                    invalid={Boolean(actionData?.errors?.password) || undefined}
                                    invalidText={actionData?.errors?.password ? actionData?.errors?.password : undefined}
                                />
                                <Button iconPosition="right" size="sm" icon={<ArrowRightIcon />} type="submit">
                                    {setup ? "Create account" : "Login"}
                                </Button>
                            </div>
                        </Form>
                    </div>
                    <div className="flex flex-col items-center justify-center mt-4">
                        <GitHubWidget repo="n-for-all/psqlcarbon" version={packageJson.version} title={"PsqlCarbon"} />
                    </div>
                </div>
            </div>
        </>
    );
}
