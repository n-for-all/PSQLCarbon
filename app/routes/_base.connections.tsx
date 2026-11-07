import db, { testConnection } from "~/lib/db";

import { ActionFunction, LoaderFunction } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import React, { useEffect } from "react";
import { ConnectionModal } from "~/components/connection";
import { useIsDesktop } from "~/utils/desktop";

import {
    addUserDbConnection,
    commitSession,
    getUserDbConnection,
    getUserDbConnections,
    getSessionConnection,
    getUserId,
    getUserSession,
    removeUserDbConnection,
    requireUser,
    updateUserDbConnection,
} from "~/utils/session.server";
import { isValidDatabaseName, validateConnectionString } from "~/utils/functions";
import { DbConnection } from "@prisma/client";
import { Logo } from "~/components/logo";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "~/ui/accordion";
import { Button } from "~/ui/button";
import ActionableNotification from "~/ui/actionable-notification";
import { CheckCircleIcon, PencilIcon, PlusIcon, SearchIcon, VersionsIcon } from "@primer/octicons-react";
import { toast } from "~/ui/hooks/use-toast";

export const loader: LoaderFunction = async ({ request }) => {
    const user = await requireUser(request, "/login?redirect=/profile");
    const connections = await getUserDbConnections(user.id);
    const connection = await getSessionConnection(request);

    return Response.json(
        { current: connection, connections },
        {
            headers: {
                "Cache-Control": "no-store",
            },
        }
    );
};

const validate = ({
    name,
    connectionString,
    tls,
    tlsAllowInvalidCertificates,
    tlsCAFile,
    tlsCertificateKeyFile,
    tlsCertificateKeyFilePassword,
    maxPoolSize,
    whitelist,
    blacklist,
}) => {
    const errors = {};

    if (!name || name.trim() == "" || name.length < 3) {
        errors["name"] = "Name must be at least 3 characters long";
    }

    if (!connectionString || connectionString.trim() == "" || !validateConnectionString(connectionString)) {
        errors["connectionString"] = "Invalid connection string";
    }

    if (tls) {
        if (!tlsCAFile || tlsCAFile.trim() == "") {
            errors["tlsCAFile"] = "CA file is required";
        }
        if (!tlsCertificateKeyFile || tlsCertificateKeyFile.trim() == "") {
            errors["tlsCertificateKeyFile"] = "Certificate key file is required";
        }
        if (!tlsCertificateKeyFilePassword || tlsCertificateKeyFilePassword.trim() == "") {
            errors["tlsCertificateKeyFilePassword"] = "Certificate key file password is required";
        }
    }

    if (maxPoolSize < 0 || maxPoolSize > 100) {
        errors["maxPoolSize"] = "Max pool size must be between 0 and 100";
    }

    if (whitelist && whitelist.trim() != "") {
        const dbs = whitelist.split(",");
        for (const db of dbs) {
            if (db.trim() == "" || !isValidDatabaseName(db.trim())) {
                errors["whitelist"] = "Invalid database name";
                break;
            }
        }
    }

    if (blacklist && blacklist.trim() != "") {
        const dbs = blacklist.split(",");
        for (const db of dbs) {
            if (db.trim() == "" || !isValidDatabaseName(db.trim())) {
                errors["blacklist"] = "Invalid database name";
                break;
            }
        }
    }

    return errors;
};

export const action: ActionFunction = async ({ request }) => {
    const jsonQuery = await request.json();

    if (jsonQuery.connect) {
        const { id } = jsonQuery.connect;
        if (!id || typeof id != "string") {
            return {
                status: "error",
                message: "Connection is invalid or doesn't exist",
            };
        }
        const userId = await getUserId(request);
        if (!userId || typeof userId != "string") {
            return {
                status: "error",
                message: "Your session expired, Please login again",
            };
        }

        try {
            const connection = await getUserDbConnection(userId, id);

            if (connection) {
                const mongo = await db(connection);
                await mongo.getDatabases();

                const session = await getUserSession(request);
                session.set("connectionId", connection.id);
                return Response.json(
                    {
                        status: "success",
                        redirect: "/",
                    },
                    {
                        headers: {
                            "Set-Cookie": await commitSession(session),
                        },
                    }
                );
            }
            return {
                status: "error",
                message: "Connection is invalid or doesn't exist",
            };
        } catch (e: any) {
            return {
                status: "error",
                message: e.message,
            };
        }
    } else if (jsonQuery.add) {
        const {
            name,
            connectionString,
            tls,
            tlsAllowInvalidCertificates,
            tlsCAFile,
            tlsCertificateKeyFile,
            tlsCertificateKeyFilePassword,
            maxPoolSize,
            whitelist,
            blacklist,
        } = jsonQuery.add;
        const errors = validate(jsonQuery.add);
        if (Object.keys(errors).length > 0) {
            return Response.json({
                status: "error",
                message: "Please fix the field errors and try again",
                errors: errors,
            });
        }

        const userId = await getUserId(request);
        if (!userId || typeof userId != "string") {
            return Response.json({
                status: "error",
                message: "Your session expired, Please login again",
            });
        }
        try {
            await testConnection({
                name: "admin",
                connectionString,
                tls,
                tlsAllowInvalidCertificates,
                tlsCAFile,
                tlsCertificateKeyFile,
                tlsCertificateKeyFilePassword,
                maxPoolSize,
                whitelist,
                blacklist,
            });
            const newConnection = await addUserDbConnection(userId, {
                name,
                connectionString,
                tls,
                tlsAllowInvalidCertificates,
                tlsCAFile,
                tlsCertificateKeyFile,
                tlsCertificateKeyFilePassword,
                maxPoolSize,
                whitelist,
                blacklist,
                allowDiskUse: true
            });

            // Saved only, the page then offers to connect to it
            return Response.json({
                status: "success",
                message: "Connection added successfully",
                id: newConnection.id,
            });
        } catch (e: any) {
            return Response.json({
                status: "error",
                message: e.message,
            });
        }
    } else if (jsonQuery.delete) {
        const { id } = jsonQuery.delete;

        if (!id || typeof id != "string") {
            return Response.json({
                status: "error",
                message: "Connection is invalid or doesn't exist",
            });
        }

        const userId = await getUserId(request);
        if (!userId || typeof userId != "string") {
            return Response.json({
                status: "error",
                message: "Your session expired, Please login again",
            });
        }
        try {
            await removeUserDbConnection(userId, id);

            return Response.json({
                status: "success",
                message: "Connection delete successfully",
            });
        } catch (e: any) {
            return Response.json({
                status: "error",
                message: e.message,
            });
        }
    } else if (jsonQuery.edit) {
        const {
            id,
            name,
            connectionString,
            tls,
            tlsAllowInvalidCertificates,
            tlsCAFile,
            tlsCertificateKeyFile,
            tlsCertificateKeyFilePassword,
            maxPoolSize,
            whitelist,
            blacklist,
        } = jsonQuery.edit;

        if (!id || typeof id != "string") {
            return Response.json({
                status: "error",
                message: "Connection is invalid or doesn't exist",
            });
        }

        const errors = validate(jsonQuery.edit);
        if (Object.keys(errors).length > 0) {
            return Response.json({
                status: "error",
                message: "Please fix the field errors and try again",
                errors: errors,
            });
        }

        const userId = await getUserId(request);
        if (!userId || typeof userId != "string") {
            return Response.json({
                status: "error",
                message: "Your session expired, Please login again",
            });
        }
        try {
            await testConnection({
                name,
                connectionString,
                tls,
                tlsAllowInvalidCertificates,
                tlsCAFile,
                tlsCertificateKeyFile,
                tlsCertificateKeyFilePassword,
                maxPoolSize,
                whitelist,
                blacklist,
            });
            await updateUserDbConnection(userId, id, {
                name,
                connectionString,
                tls,
                tlsAllowInvalidCertificates,
                tlsCAFile,
                tlsCertificateKeyFile,
                tlsCertificateKeyFilePassword,
                maxPoolSize,
                whitelist,
                blacklist,
                allowDiskUse: true
            });

            return Response.json({
                status: "success",
                message: "Connection updated successfully",
            });
        } catch (e: any) {
            return Response.json({
                status: "error",
                message: e.message,
            });
        }
    }
    return Response.json({ status: "error", message: "Invalid submit" });
};

type DetectedConnection = {
    id: string;
    name: string;
    source: string;
    host: string;
    port: number;
    user: string;
    database: string;
    connectionString: string;
    status: "ready" | "needs_password" | "unreachable" | "error";
    message?: string;
    version?: string;
    databases?: string[];
    logins?: { user: string; connectionString: string }[];
};

const DETECTED_STATUS: Record<DetectedConnection["status"], { label: string; className: string }> = {
    ready: { label: "Ready", className: "bg-green-100 text-green-800" },
    needs_password: { label: "Needs password", className: "bg-amber-100 text-amber-800" },
    unreachable: { label: "Not reachable", className: "bg-neutral-200 text-neutral-600" },
    error: { label: "Error", className: "bg-red-100 text-red-700" },
};

const DetectedConnections = ({ autoDetect, onAdd }: { autoDetect: boolean; onAdd: (detected: DetectedConnection) => void }) => {
    const desktop = useIsDesktop();
    const [detected, setDetected] = React.useState<DetectedConnection[] | null>(null);
    // Chosen login per detected server, when more than one user can log in
    const [logins, setLogins] = React.useState<Record<string, string>>({});
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const detect = async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch("/api/detect-connections");
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Detection failed");
            setDetected(data.detected);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (autoDetect) detect();
    }, [autoDetect]);

    return (
        <div className="mt-6">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">Detected on this machine</div>
                    <div className="text-xs text-neutral-500">{desktop ? "PostgreSQL servers running on this computer" : "Local servers, ~/.pgpass, pg_service.conf and PG* variables"}</div>
                </div>
                <Button size="sm" variant="outline" icon={<SearchIcon />} loading={loading} onClick={detect}>
                    {detected ? "Detect again" : "Detect"}
                </Button>
            </div>
            {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
            {detected && detected.length === 0 && !loading && <div className="mt-3 text-xs text-neutral-500">No new PostgreSQL servers found.</div>}
            {detected && detected.length > 0 && (
                <div className="flex flex-col mt-3 border border-neutral-200">
                    {detected.map((item) => {
                        const login = item.logins?.find((option) => option.user === logins[item.id]) || item.logins?.[0];
                        const selected = login ? { ...item, user: login.user, connectionString: login.connectionString } : item;
                        return (
                        <div key={item.id} className="flex items-start gap-3 p-3 border-t first:border-t-0 border-neutral-200">
                            <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">{item.name}</span>
                                    <span className={`px-1.5 text-[10px] font-semibold uppercase ${DETECTED_STATUS[item.status].className}`}>{DETECTED_STATUS[item.status].label}</span>
                                </div>
                                <div className="font-mono text-xs break-all text-neutral-600">
                                    {selected.user}@{item.host}:{item.port}/{item.database}
                                </div>
                                {item.logins && (
                                    <label className="flex items-center gap-2 mt-1 text-xs text-neutral-600">
                                        Log in as
                                        <select
                                            className="px-1 py-0.5 text-xs border border-neutral-300 bg-white"
                                            value={selected.user}
                                            onChange={(e) => setLogins((prev) => ({ ...prev, [item.id]: e.target.value }))}>
                                            {item.logins.map((option) => (
                                                <option key={option.user} value={option.user}>
                                                    {option.user}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                )}
                                <div className="text-xs text-neutral-500">
                                    {item.source}
                                    {item.version ? ` · PostgreSQL ${item.version}` : ""}
                                    {item.databases ? ` · ${item.databases.length} databases` : ""}
                                </div>
                                {item.status === "needs_password" && <div className="text-xs text-amber-700">Add the password to the connection string before saving.</div>}
                                {(item.status === "error" || item.status === "unreachable") && item.message && <div className="text-xs text-neutral-500 break-words">{item.message}</div>}
                            </div>
                            <Button size="xs" variant={item.status === "ready" ? "default" : "outline"} icon={<PlusIcon />} onClick={() => onAdd(selected)}>
                                Add
                            </Button>
                        </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default function Dashboard() {
    const loaderData = useLoaderData<typeof loader>();

    const { connections } = loaderData;
    const navigate = useNavigate();
    const [error, setError] = React.useState<string | null>(null);
    const [current, setCurrent] = React.useState<DbConnection | null>(null);
    // The open connection in the list, and the one just added which gets offered to connect to
    const [openItem, setOpenItem] = React.useState("");
    const [added, setAdded] = React.useState<string | null>(null);

    const fetcher = useFetcher<{
        status: string;
        errors?: any;
        message?: string;
        redirect?: string;
    }>();

    // The "Connecting" message, closed once the connection answers
    const connectingToast = React.useRef<{ dismiss: () => void } | null>(null);
    useEffect(() => {
        if (fetcher.state == "submitting") {
            connectingToast.current = toast({
                duration: 10000,
                type: "background",
                title: "Connecting, Please wait...",
                description: `Connecting to "${current?.name}"`,
                variant: "warning",
            });
        }
    }, [fetcher.state]);

    useEffect(() => {
        connectingToast.current?.dismiss();
        if (fetcher.data && fetcher.data.status == "success") {
            // Navigating inside the app shows the loading screen while the first page loads
            navigate(fetcher.data.redirect || "/");
            return;
        } else if (fetcher.data && fetcher.data.status == "error") {
            setError(fetcher.data.message || null);
        }

        setCurrent(null);
    }, [fetcher.data]);

    const [connectionModal, setConnectionModal] = React.useState<{
        mode: "add" | "edit";
        open: boolean;
        connection: DbConnection | null;
    }>({
        mode: "add",
        open: false,
        connection: null,
    });

    return (
        <>
            <div className="w-full max-w-xl p-6 mx-auto my-16 mb-16 bg-white border border-solid border-neutral-200">
                <h2 className="mb-2 text-4xl font-bold">
                    <Logo className={"h-8"} />
                </h2>
                <p className="mb-10 text-sm">Welcome to PsqlCarbon, Please select or create a new connection below:</p>
                <Accordion type="single" collapsible value={openItem} onValueChange={setOpenItem} className="overflow-hidden ">
                    {connections.map((connection: DbConnection, index) => (
                        <AccordionItem key={`${connection.id}-${index}`} value={connection.id} title={connection.name} className="bg-neutral-100">
                            <AccordionTrigger className="px-4 border-t border-solid border-neutral-200">
                                <span className="font-medium">{connection.name}</span>
                            </AccordionTrigger>

                            <AccordionContent className="px-4">
                                {added === connection.id && (
                                    <div className="flex items-center gap-2 px-3 py-2 mb-3 text-sm text-green-800 bg-green-50 border border-green-200">
                                        <CheckCircleIcon size={16} className="shrink-0" />
                                        Connection saved and tested. Connect to it now?
                                    </div>
                                )}
                                <div className="flex flex-col gap-2 break-all">
                                    <div className="flex flex-col py-2 border-t border-b border-solid border-neutral-200">
                                        <span className="text-sm">Connection String:</span> <span className="font-medium">{connection.connectionString}</span>
                                    </div>
                                    <div className="flex py-2 text-sm border-b border-solid border-neutral-200">
                                        <span>Max Pool Size:</span> <span className="ml-2">{connection.maxPoolSize}</span>
                                    </div>

                                    <div className="flex flex-col py-2 text-sm border-b border-solid border-neutral-200">
                                        <span>Whitelist:</span> <span className="ml-2">{connection.whitelist}</span>
                                    </div>
                                    <div className="flex flex-col py-2 text-sm border-b border-solid border-neutral-200">
                                        <span>Blacklist:</span> <span className="ml-2">{connection.blacklist}</span>
                                    </div>
                                </div>

                                <div className="flex w-full gap-2 mt-4">
                                    <Button
                                        size="sm"
                                        variant={"default"}
                                        loading={!!current && current.id == connection.id}
                                        icon={<VersionsIcon />}
                                        autoFocus={added === connection.id}
                                        onClick={() => {
                                            setCurrent(connection);
                                            setAdded(null);
                                            fetcher.submit(
                                                {
                                                    connect: connection,
                                                },
                                                {
                                                    method: "POST",
                                                    encType: "application/json",
                                                    action: `/connections`,
                                                }
                                            );
                                        }}>
                                        Connect
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        icon={<PencilIcon />}
                                        onClick={() => {
                                            setConnectionModal({ mode: "edit", open: true, connection });
                                        }}
                                        className="ml-auto">
                                        Edit
                                    </Button>
                                </div>
                            </AccordionContent>
                        </AccordionItem>
                    ))}
                </Accordion>
                <div className="flex gap-2 mt-4">
                    <Button
                        size="sm"
                        variant={"secondary"}
                        icon={<VersionsIcon />}
                        onClick={() => {
                            setConnectionModal({ mode: "add", open: true, connection: null });
                        }}>
                        Add Connection
                    </Button>
                    {loaderData.current && (
                        <Button
                            size="sm"
                            variant={"outline"}
                            onClick={() => navigate("/")}>
                            Return to Dashboard
                        </Button>
                    )}
                </div>
                <DetectedConnections
                    autoDetect={connections.length === 0}
                    onAdd={(detected) =>
                        setConnectionModal({
                            mode: "add",
                            open: true,
                            connection: {
                                id: undefined,
                                name: `${detected.name} (${detected.user})`.replace(/[^\w .:()-]/g, "").slice(0, 60),
                                connectionString: detected.connectionString,
                                tls: false,
                                tlsAllowInvalidCertificates: false,
                                tlsCAFile: "",
                                tlsCertificateKeyFile: "",
                                tlsCertificateKeyFilePassword: "",
                                maxPoolSize: 4,
                                whitelist: "",
                                blacklist: "",
                            } as any,
                        })
                    }
                />
            </div>

            {error && (
                <div className="fixed -translate-x-1/2 left-1/2 bottom-10">
                    <ActionableNotification variant="error" title="Error" subtitle={error} closeOnEscape inline={false} onClose={() => setError(null)} />
                </div>
            )}
            <ConnectionModal
                open={connectionModal.open}
                mode={connectionModal.mode}
                initialData={connectionModal.connection}
                onSuccess={(result) => {
                    if (result?.id) {
                        setAdded(result.id);
                        setOpenItem(result.id);
                    } else {
                        window.location.reload();
                    }
                }}
                onClose={() => {
                    setConnectionModal({ ...connectionModal, open: false, connection: null });
                }}
            />
        </>
    );
}
