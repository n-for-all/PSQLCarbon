import { LoaderFunction } from "@remix-run/node";
import { Outlet, useLoaderData } from "@remix-run/react";
import { requireUser } from "~/utils/session.server";
import { Link, redirect } from "@remix-run/react";
import { Logo } from "~/components/logo";
import SkipToContent from "~/ui/skip-to-content";
import { Header, HeaderAction, HeaderActions, HeaderName } from "~/ui/header";
import { ThemeToggle } from "~/components/theme-toggle";
import { Avatar, AvatarFallback } from "~/ui/avatar";
import { GearIcon, HomeIcon, SignOutIcon } from "@primer/octicons-react";
import { useIsDesktop, useMacTitlebar } from "~/utils/desktop";
import { PageLoadingOverlay } from "~/components/page-loading";
import { TitleBar, TitleBarButton, titleBarButtonClass } from "~/components/title-bar";

export const loader: LoaderFunction = async ({ request }) => {
    try {
        const user = await requireUser(request, "/login");
        return Response.json(
            { user },
            {
                headers: {
                    "Cache-Control": "no-store",
                },
            }
        );
    } catch (e) {
        if (e instanceof Response) {
            return e;
        }
        return redirect("/login");
    }
};

export default function Dashboard() {
    const desktop = useIsDesktop();
    const macTitlebar = useMacTitlebar();
    const { user } = useLoaderData<typeof loader>();
    return (
        <>
            {macTitlebar ? (
                // The macOS desktop app's title bar replaces the header, the traffic lights sit on its left
                <TitleBar>
                    <TitleBarButton label="Back to the dashboard" to="/">
                        <HomeIcon size={16} />
                    </TitleBarButton>
                    <div className="flex-1 self-stretch" />
                    <ThemeToggle className={titleBarButtonClass} iconSize={16} />
                    <TitleBarButton label="Settings" to="/profile">
                        <GearIcon size={16} />
                    </TitleBarButton>
                </TitleBar>
            ) : (
            <Header aria-label="" className="h-12">
                <SkipToContent />
                <HeaderName name="PsqlCarbon" as={Link} to="/">
                    <Logo className={"h-5"} />
                </HeaderName>
                <HeaderActions>
                    <ThemeToggle />
                    <HeaderAction aria-label={desktop ? "Settings" : "User Profile"}>
                        <Link to="/profile">
                            {/* The desktop app has no accounts, the page holds its settings */}
                            {desktop ? (
                                <GearIcon size={20} className="text-neutral-500" />
                            ) : (
                                <Avatar className="bg-primary text-primary-foreground">
                                    <AvatarFallback>{(user.username as string).substring(0, 2).toUpperCase()}</AvatarFallback>
                                </Avatar>
                            )}
                        </Link>
                    </HeaderAction>

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
            <div className={`relative flex flex-col h-screen overflow-auto bg-neutral-100 ${macTitlebar ? "pt-10" : ""}`}>
                <PageLoadingOverlay className={`fixed ${macTitlebar ? "top-10" : "top-12"}`} />
                <div className="flex flex-col items-start justify-start flex-1 w-full mx-auto">
                    <Outlet />
                </div>
            </div>
        </>
    );
}
