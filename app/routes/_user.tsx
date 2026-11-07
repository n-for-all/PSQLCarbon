import { Outlet, useLoaderData, useParams, useRevalidator, type ShouldRevalidateFunction } from "@remix-run/react";
import { Link, redirect, useLocation } from "@remix-run/react";
import { useNavigate } from "@remix-run/react";
import packageJson from "../../package.json";

import { ChevronLeftIcon, ChevronRightIcon, DatabaseIcon, EyeIcon, PlusIcon, SignOutIcon, ThreeBarsIcon, XIcon, DependabotIcon, GearIcon, MarkGithubIcon, CommentDiscussionIcon, SyncIcon, SidebarCollapseIcon, SidebarExpandIcon } from "@primer/octicons-react";
import { LoaderFunction } from "@remix-run/node";
import { commitSession, getSessionConnection, getUserDbConnections, getUserSession, requireUser, User } from "~/utils/session.server";
import db, { ConnectionData } from "~/lib/db";
import { colsToGrid } from "~/utils/functions";
import React, { ReactElement, useEffect, useState, useCallback } from "react";
import { SwitchConnection } from "~/components/connection";
import { DbConnection } from "@prisma/client";
import { DatabaseAddModal } from "~/components/database";
import { GithubButton } from "~/components/github_widget";
import { SupportMenu } from "~/components/support-menu";
import { ThemeToggle } from "~/components/theme-toggle";
import { Logo } from "~/components/logo";
import SkipToContent from "~/ui/skip-to-content";
import { HeaderNavigation, Header, HeaderAction, HeaderActions, HeaderMenuButton, HeaderMenuItem, HeaderName } from "~/ui/header";
import { Avatar, AvatarFallback } from "~/ui/avatar";
import { TreeNode, TreeView } from "~/ui/tree";

import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarProvider } from "~/ui/sidebar";
import { AiChatPanel } from "~/components/ai-chat-panel";
import { useIsDesktop, useMacTitlebar } from "~/utils/desktop";
import { PageLoadingOverlay } from "~/components/page-loading";
import { TitleBar, TitleBarButton, titleBarButtonClass } from "~/components/title-bar";
import { EarlyAccess } from "~/components/early-access";
import { FeedbackDialog } from "~/components/feedback";
import { useResizable } from "~/ui/hooks/use-resizable";

interface UUID {
    $uuid: string;
}
interface Info {
    readOnly: boolean;
    uuid: UUID;
}

interface IdIndex {
    v: number;
    key: { [key: string]: number };
    name: string;
}

interface MongoDbCollection {
    name: string;
    type: string;
    options: object;
    info: Info;
    idIndex: IdIndex;
}

type ProfileLoaderData = {
    user: User;
};

export const loader: LoaderFunction = async ({ request }) => {
    try {
        const user = await requireUser(request, "/login");
        const connections = await getUserDbConnections(user.id);
        let connection = await getSessionConnection(request);
        const headers: HeadersInit = { "Cache-Control": "no-store" };

        if (!connection) {
            if (connections.length == 1) {
                // If there is only one connection, set it as the default
                const session = await getUserSession(request);
                session.set("connectionId", connections[0].id);
                headers["Set-Cookie"] = await commitSession(session);
                connection = connections[0];
            } else {
                return redirect("/connections");
            }
        }

        let mongo: ConnectionData;

        try {
            mongo = await db(connection);
        } catch (error: any) {
            return Response.json({ status: "error", message: "Error: " + error.message }, { status: 500 });
        }

        const databases = await mongo.getDatabases(); // List of database names

        // One round trip per database, done side by side so a remote server doesn't add them all up
        const collections = Object.fromEntries(await Promise.all(databases.map(async (dbName) => [dbName, await mongo.getCollections({ dbName })])));
        const gridFSBuckets = colsToGrid(collections);

        const result: ProfileLoaderData & {
            connection: DbConnection;
            connections: Array<DbConnection>;
            databases: string[];
            collections: Record<string, string[]>;
            gridFSBuckets: { [x: string]: string[] };
        } = { user, databases, connections, connection, collections, gridFSBuckets };

        return Response.json(result, { headers });
    } catch (e: any) {
        if (e instanceof Response) {
            return e;
        }
        return redirect(`/error?message=${e.message}`);
    }
};

/**
 * The sidebar lists every database and its tables, a round trip per database that a remote server makes slow.
 * It's only reloaded after a change (a form or fetcher submission) or when asked, not on every click.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({ formMethod, currentUrl, nextUrl, defaultShouldRevalidate }) => {
    if (!formMethod && currentUrl.href !== nextUrl.href) return false;
    return defaultShouldRevalidate;
};

/**
 * Small tab on the edge of a side panel, it points the way the panel will move when clicked
 */
const PanelHandle = ({ side, open, offset = 0, label, onClick }: { side: "left" | "right"; open: boolean; offset?: number; label: string; onClick: () => void }) => {
    const pointsLeft = side === "left" ? open : !open;
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={`${open ? "Collapse" : "Expand"} the ${label}`}
            title={`${open ? "Collapse" : "Expand"} the ${label}`}
            style={side === "left" ? { left: 0 } : { right: offset }}
            className={`absolute top-1/2 z-30 flex items-center justify-center w-4 h-12 -translate-y-1/2 border bg-white text-neutral-400 border-neutral-200 shadow-sm hover:text-neutral-900 hover:bg-neutral-50 ${
                side === "left" ? "rounded-r border-l-0" : "rounded-l border-r-0"
            }`}>
            {pointsLeft ? <ChevronLeftIcon size={12} /> : <ChevronRightIcon size={12} />}
        </button>
    );
};

export default function Layout() {
    const desktop = useIsDesktop();
    const macTitlebar = useMacTitlebar();
    const loaderData = useLoaderData<typeof loader>();
    const navigate = useNavigate();

    const [isSideNavExpanded, setIsSideNavExpanded] = useState(true);
    const [isCreateDatabase, setIsCreateDatabase] = useState(false);
    const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
    // Open by default, closing it is remembered
    const [isAiChatOpen, setIsAiChatOpen] = useState(true);
    const chat = useResizable({ storageKey: "ai_chat_panel_width", defaultWidth: 380, min: 300, max: 1000, edge: "left" });
    const sidebar = useResizable({ storageKey: "sidebar_width", defaultWidth: 384, min: 220, max: 640, edge: "right" });
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const savedIsOpen = localStorage.getItem("ai_chat_open");
        if (savedIsOpen === "false") {
            setIsAiChatOpen(false);
        }
        if (localStorage.getItem("sidebar_open") === "false") {
            setIsSideNavExpanded(false);
        }

        setMounted(true);
    }, []);

    useEffect(() => {
        if (!mounted) return;
        localStorage.setItem("ai_chat_open", String(isAiChatOpen));
    }, [isAiChatOpen, mounted]);

    useEffect(() => {
        if (!mounted) return;
        localStorage.setItem("sidebar_open", String(isSideNavExpanded));
    }, [isSideNavExpanded, mounted]);


    // From the URL rather than the loader, which doesn't run again on every click (see shouldRevalidate)
    const params = useParams();
    const selectedDb = params.db || "";
    const selectedCollection = params.db ? params.col || "" : "";
    const [current, setCurrent] = useState({
        db: selectedDb,
        collection: selectedCollection,
    });

    useEffect(() => {
        if (selectedDb != current.db || selectedCollection != current.collection) {
            setCurrent({
                db: selectedDb,
                collection: selectedCollection,
            });
        }
    }, [selectedDb]);

    let collectionsElms: ReactElement[] = [];
    if (loaderData) {
        const databases = Object.keys(loaderData.collections);
        databases.sort((a: string, b: string) => {
            return a > b ? 1 : -1;
        });
        collectionsElms = databases.map((database, indexDb: number) => {
            const collections = loaderData.collections[database].sort((a: MongoDbCollection, b: MongoDbCollection) => {
                return a.name > b.name ? 1 : -1;
            });

            return (
                <TreeNode
                    active={database == current.db}
                    isExpanded={database == current.db}
                    onSelect={() => {
                        setCurrent({
                            db: database,
                            collection: "",
                        });
                        navigate(`/database/${database}`);
                    }}
                    key={database}
                    label={
                        <span className="flex items-center gap-2">
                            <span className="font-mono text-[13px] truncate" title={database}>{database}</span>
                            {["postgres", "template0", "template1"].includes(database) && (
                                <span className="px-1.5 py-0.5 text-[9px] font-medium leading-none text-neutral-500 bg-neutral-200/50 rounded border border-neutral-200">
                                    SYS
                                </span>
                            )}
                        </span>
                    }
                    onToggle={(e, node) => {
                        const isExpanded = node?.isExpanded;
                        setCurrent(
                            isExpanded
                                ? {
                                      db: database,
                                      collection: "",
                                  }
                                : {
                                      db: "",
                                      collection: "",
                                  }
                        );
                        console.log("Toggle", node);
                    }}
                    tabIndex={0}>
                    {collections.map((collection: MongoDbCollection, indexCol: number) => {
                        return (
                            <TreeNode
                                active={database == current.db && collection.name == current.collection}
                                onSelect={() => {
                                    setCurrent({
                                        db: database,
                                        collection: collection.name,
                                    });
                                    navigate(`/database/${database}/${collection.name}`);
                                }}
                                icon={<DatabaseIcon size={12} className="shrink-0" />}
                                key={`${database}-${collection.name}`}
                                label={<span className="font-mono text-[13px] truncate" title={collection.name}>{collection.name}</span>}
                                onToggle={(e, node) => {
                                    setCurrent({
                                        db: database,
                                        collection: collection.name,
                                    });
                                    console.log("Toggle", node);
                                }}
                            />
                        );
                    })}
                </TreeNode>
            );
        });
    }

    const onCreateDatabase = () => {
        setIsCreateDatabase(true);
    };
    const { pathname } = useLocation();
    // Reloads the databases and tables, the sidebar otherwise only refreshes after a change made in the app
    const revalidator = useRevalidator();

    const treeView = (
        <>
            <div className="flex items-center justify-between px-4 py-2 bg-neutral-100">
                <span className="block text-xs uppercase opacity-50">Databases</span>
                <span className="flex items-center gap-3">
                    <button
                        type="button"
                        title="Refresh databases and tables"
                        aria-label="Refresh databases and tables"
                        disabled={revalidator.state !== "idle"}
                        onClick={() => revalidator.revalidate()}
                        className="text-xs opacity-50 hover:opacity-100 disabled:opacity-30">
                        <SyncIcon className={revalidator.state !== "idle" ? "animate-spin" : ""} />
                    </button>
                    <Link title="All databases" aria-label="All databases" className="text-xs uppercase opacity-50 hover:underline hover:opacity-100" to={"/database"}>
                        <EyeIcon />
                    </Link>
                </span>
            </div>
            <TreeView size="sm" multiselect={false} hideLabel={true} label={"Databases"} aria-expanded={true} className="bg-neutral-100">
                {collectionsElms}
            </TreeView>
        </>
    );

    return (
        <>
            {macTitlebar && (
                // The macOS desktop app's title bar replaces the header, the traffic lights sit on its left
                <TitleBar>
                    <TitleBarButton label={isSideNavExpanded ? "Hide the sidebar" : "Show the sidebar"} onClick={() => setIsSideNavExpanded(!isSideNavExpanded)}>
                        {isSideNavExpanded ? <SidebarCollapseIcon size={16} /> : <SidebarExpandIcon size={16} />}
                    </TitleBarButton>
                    <SwitchConnection
                        current={loaderData.connection}
                        connections={loaderData.connections}
                        triggerClassName="h-7 w-[220px] ml-1 px-2.5 text-[13px] rounded-md border-neutral-200 bg-white"
                    />
                    <div className="flex-1 self-stretch" />
                    <EarlyAccess className="mr-1" />
                    <TitleBarButton label="Send feedback" onClick={() => setIsFeedbackOpen(true)}>
                        <CommentDiscussionIcon size={16} />
                    </TitleBarButton>
                    <TitleBarButton label="AI assistant" active={isAiChatOpen} onClick={() => setIsAiChatOpen(!isAiChatOpen)}>
                        <DependabotIcon size={16} />
                    </TitleBarButton>
                    <ThemeToggle className={titleBarButtonClass} iconSize={16} />
                    <SupportMenu className={titleBarButtonClass} iconSize={16} />
                    <TitleBarButton label="PSQLCarbon on GitHub" href="https://github.com/n-for-all/psqlcarbon">
                        <MarkGithubIcon size={16} />
                    </TitleBarButton>
                    <TitleBarButton label="Settings" to="/profile">
                        <GearIcon size={16} />
                    </TitleBarButton>
                </TitleBar>
            )}
            <SidebarProvider
                defaultOpen={true}
                open={isSideNavExpanded}
                style={{ "--sidebar-width": `${sidebar.width}px` } as React.CSSProperties}
                // The sidebar animates its width, which makes dragging lag behind the mouse
                className={`${sidebar.resizing ? "[&_*]:!transition-none" : ""} ${macTitlebar ? "pt-10 h-svh overflow-hidden" : ""}`}>
                <Sidebar className={macTitlebar ? "top-10 h-[calc(100svh-2.5rem)]" : undefined}>
                    {macTitlebar && (
                        <Link to="/" aria-label="Home" className="flex items-center h-12 px-4 shrink-0">
                            <Logo className="h-[18px]" />
                        </Link>
                    )}
                    <div
                        onMouseDown={sidebar.startResizing}
                        className="absolute top-0 bottom-0 right-0 z-20 w-1 transition-colors cursor-col-resize hover:bg-primary/50"
                        style={{ transform: "translateX(50%)" }}
                        aria-label="Resize sidebar"
                    />
                    <SidebarContent>
                        <SidebarGroup>
                            <SidebarGroupContent>
                                <div className="flex flex-wrap justify-between gap-2 mb-4">
                                    <HeaderNavigation aria-label="New Database">
                                        <HeaderMenuItem variant="outline" icon={<PlusIcon />} onClick={onCreateDatabase}>
                                            New Database
                                        </HeaderMenuItem>
                                    </HeaderNavigation>
                                </div>
                                <div className="relative top-0 left-0 w-full h-full overflow-auto">{treeView}</div>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    </SidebarContent>
                </Sidebar>
                <div className="relative w-full overflow-hidden transition">
                    {!macTitlebar && (
                    <Header className="z-50 h-12 bg-white shadow" aria-label="Header">
                        <SkipToContent />
                        <HeaderActions>
                            <HeaderMenuButton
                                aria-label="Open menu"
                                renderMenuIcon={<ThreeBarsIcon />}
                                renderCloseIcon={<XIcon />}
                                onClick={() => {
                                    setIsSideNavExpanded(!isSideNavExpanded);
                                }}
                                isActive={isSideNavExpanded}
                            />
                            <HeaderName as={Link} to="/">
                                <Logo className={"h-5"} />
                            </HeaderName>
                            <HeaderNavigation aria-label="Connections">
                                <HeaderMenuItem as={"div"} className="flex items-center mr-4">
                                    <SwitchConnection current={loaderData.connection} connections={loaderData.connections} />
                                </HeaderMenuItem>
                            </HeaderNavigation>
                            {/* <HeaderNavigation aria-label="New Database">
                                <HeaderMenuItem onClick={onCreateDatabase}>New Database</HeaderMenuItem>
                            </HeaderNavigation> */}
                        </HeaderActions>
                        <HeaderActions>
                            <EarlyAccess />
                            <HeaderAction aria-label="Send feedback" onClick={() => setIsFeedbackOpen(true)}>
                                <CommentDiscussionIcon size={20} className="text-neutral-500" />
                            </HeaderAction>
                            <HeaderAction aria-label="AI Assistant" onClick={() => setIsAiChatOpen(!isAiChatOpen)}>
                                <DependabotIcon size={20} className={isAiChatOpen ? "text-primary" : "text-neutral-500"} />
                            </HeaderAction>
                            <ThemeToggle />
                            <SupportMenu />
                            <GithubButton repo="n-for-all/psqlcarbon" version={packageJson.version} title={"PSQLCarbon"} />
                            <Link to="/profile">
                                {/* The desktop app has no accounts, the page holds its settings */}
                                <HeaderAction aria-label={desktop ? "Settings" : "User Profile"}>
                                    {desktop ? (
                                        <GearIcon size={20} className="text-neutral-500" />
                                    ) : (
                                        <Avatar className="bg-primary text-primary-foreground">
                                            <AvatarFallback>{(loaderData.user.username as string).substring(0, 2).toUpperCase()}</AvatarFallback>
                                        </Avatar>
                                    )}
                                </HeaderAction>
                            </Link>
                            {!desktop && (
                                <HeaderAction aria-label="Logout">
                                    <Link to={"/logout"}>
                                        <SignOutIcon size={20} />
                                    </Link>
                                </HeaderAction>
                            )}
                        </HeaderActions>
                    </Header>
                    )}

                    <div className={`relative flex-1 transition ${macTitlebar ? "h-[calc(100vh-2.5rem)]" : "h-[calc(100vh-3rem)]"}`}>
                        {/* Handles on the panel edges to collapse and expand them quickly */}
                        <PanelHandle side="left" open={isSideNavExpanded} label="databases sidebar" onClick={() => setIsSideNavExpanded(!isSideNavExpanded)} />
                        <PanelHandle side="right" open={isAiChatOpen} offset={isAiChatOpen ? chat.width : 0} label="AI assistant" onClick={() => setIsAiChatOpen(!isAiChatOpen)} />
                        <div className="absolute inset-0 pl-0 pr-0 overflow-hidden">
                            <div className="flex h-full w-full">
                                <div className="relative flex-1 min-w-0">
                                    <div className="absolute inset-0 overflow-auto">
                                        <div className="px-4 py-4 lg:px-6">
                                            <Outlet key={pathname + "-content"} />
                                        </div>
                                    </div>
                                    <PageLoadingOverlay />
                                </div>
                                {isAiChatOpen && (
                                    <div 
                                        style={{ width: chat.width }} 
                                        className="border-l border-neutral-200 bg-white flex flex-col shrink-0 h-full relative"
                                    >
                                        {/* Resize Handle */}
                                        <div 
                                            onMouseDown={chat.startResizing}
                                            className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors z-10"
                                            style={{ transform: 'translateX(-50%)' }}
                                        />
                                        <AiChatPanel
                                            db={current.db}
                                            table={current.collection}
                                            columns={[]}
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                </div>
            </SidebarProvider>
            <FeedbackDialog open={isFeedbackOpen} onClose={() => setIsFeedbackOpen(false)} />
            <DatabaseAddModal
                open={isCreateDatabase}
                onClose={() => {
                    setIsCreateDatabase(false);
                }}
                onSuccess={(dbName) => {
                    setIsCreateDatabase(false);
                    navigate(`/database/${dbName}`, { replace: true });
                }}
            />
        </>
    );
}
