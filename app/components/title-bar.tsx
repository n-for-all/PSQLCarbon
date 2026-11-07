import { Link } from "@remix-run/react";
import React from "react";
import { cn } from "~/ui/lib/utils";

/**
 * The window's title bar in the macOS desktop app, which has no native one (electron/main.js). It runs across the
 * whole window, the traffic lights sit in its left padding and empty parts of it move the window.
 */
export const TitleBar = ({ children, className }: { children: React.ReactNode; className?: string }) => (
	<div className={cn("fixed inset-x-0 top-0 z-50 flex items-center h-10 gap-1 pr-2 border-b app-drag pl-[76px] bg-neutral-100 border-neutral-200", className)}>{children}</div>
);

// Small square toolbar button, like the ones in a native window toolbar
export const titleBarButtonClass =
	"flex items-center justify-center w-7 h-7 rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-200/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50";

type TitleBarButtonProps = { label: string; active?: boolean; children: React.ReactNode } & (
	| { to: string; onClick?: never; href?: never }
	| { href: string; to?: never; onClick?: never }
	| { onClick: () => void; to?: never; href?: never }
);

export const TitleBarButton = ({ label, active, children, to, href, onClick }: TitleBarButtonProps) => {
	const className = cn(titleBarButtonClass, active && "text-primary hover:text-primary");
	if (to) {
		return (
			<Link to={to} aria-label={label} title={label} className={className}>
				{children}
			</Link>
		);
	}
	if (href) {
		return (
			<a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={label} className={className}>
				{children}
			</a>
		);
	}
	return (
		<button type="button" onClick={onClick} aria-label={label} title={label} className={className}>
			{children}
		</button>
	);
};
