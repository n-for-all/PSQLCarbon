import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Contrast, Moon, Sun } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "~/ui/dropdown-menu";

const OPTIONS = [
    { value: "system", label: "Auto (match system)", icon: Contrast },
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
] as const;

/**
 * Theme menu, Auto follows the operating system and is the default
 */
export const ThemeToggle = ({ className, iconSize = 18 }: { className?: string; iconSize?: number }) => {
    const { theme = "system", setTheme } = useTheme();
    // The saved theme is only known in the browser
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    const current = OPTIONS.find((option) => option.value === (mounted ? theme : "system")) || OPTIONS[0];
    const Icon = current.icon;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={`Theme: ${current.label}`}
                    title={`Theme: ${current.label}`}
                    className={className || "flex items-center justify-center w-10 h-10 text-neutral-500 hover:text-neutral-900 focus:outline-none"}>
                    <Icon size={iconSize} />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="text-xs text-neutral-500">Theme</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={current.value} onValueChange={setTheme}>
                    {OPTIONS.map((option) => (
                        <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2 text-sm cursor-pointer">
                            <option.icon size={14} />
                            {option.label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
