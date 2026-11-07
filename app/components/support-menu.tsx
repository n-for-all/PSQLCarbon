import { useRouteLoaderData } from "@remix-run/react";
import { HeartIcon, LinkExternalIcon, StarIcon } from "@primer/octicons-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/ui/hover-card";

const LINKS = [
    { href: "https://github.com/n-for-all/psqlcarbon", label: "Star on GitHub", icon: <StarIcon size={14} /> },
    { href: "https://github.com/sponsors/n-for-all", label: "Sponsor", icon: <HeartIcon size={14} />, donation: true },
    { href: "https://psqlcarbon.com", label: "Website", icon: <LinkExternalIcon size={14} /> },
];

/**
 * Heart in the header that shows the ways to support the project on hover
 */
export const SupportMenu = ({ className, iconSize = 18 }: { className?: string; iconSize?: number }) => {
    // The App Store build may not link to donations, they'd have to be In-App Purchases (guideline 3.1.1)
    const appStore = useRouteLoaderData<{ appStore?: boolean }>("root")?.appStore;
    const links = appStore ? LINKS.filter((link) => !link.donation) : LINKS;
    return (
    <HoverCard openDelay={100} closeDelay={150}>
        <HoverCardTrigger asChild>
            <button type="button" aria-label="Support PSQLCarbon" className={className || "flex items-center justify-center w-10 h-10 text-neutral-500 hover:text-pink-600"}>
                <HeartIcon size={iconSize} />
            </button>
        </HoverCardTrigger>
        <HoverCardContent align="end" className="w-64 p-3">
            <p className="mb-2 text-xs text-neutral-600">
                {appStore ? "PSQLCarbon is free and open source. If it helps you, a star on GitHub means a lot:" : "PSQLCarbon is free and open source. If it helps you, please support it:"}
            </p>
            <div className="flex flex-col gap-1">
                {links.map((link) => (
                    <a
                        key={link.href}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-2 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100">
                        {link.icon}
                        {link.label}
                    </a>
                ))}
            </div>
        </HoverCardContent>
    </HoverCard>
    );
};
