import type { Config } from "tailwindcss";

// Palettes come from CSS variables (app/tailwind.scss) so they switch with the theme
const themed = (name: string) => Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((shade) => [shade, `rgb(var(--c-${name}-${shade}) / <alpha-value>)`]));
const variable = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
    darkMode: "class",
    content: ["./app/**/{**,.client,.server}/**/*.{js,jsx,ts,tsx}"],
    theme: {
        extend: {
            fontSize: {
                xxs: "0.6rem",
                xs: "0.7rem",
                sm: "0.8rem",
                md: "0.9rem",
                base: "1rem",
                xl: "1.25rem",
                "2xl": "1.563rem",
                "3xl": "1.953rem",
                "4xl": "2.441rem",
                "5xl": "3.052rem",
            },
            colors: {
                neutral: themed("neutral"),
                gray: themed("neutral"),
                red: themed("red"),
                green: themed("green"),
                amber: themed("amber"),
                blue: themed("blue"),
                yellow: themed("yellow"),
                pink: themed("pink"),
                white: variable("white"),
                primary: "#0f62fe",
                tree: variable("white"),
                popover: variable("surface-raised"),
                "popover-foreground": variable("popover-fg"),
                tooltip: variable("tooltip"),
                "tooltip-foreground": "#ffffff",
                secondary: variable("secondary"),
                "primary-foreground": "#fff",
                error: "#e53e3e",
                "error-foreground": "#fff",
                success: "#38a169",
                "success-600": "#2f855a",
                warning: "#ed8936",
                "warning-600": "#b7791f",
                info: "#3182ce",
                "info-600": "#2c5282",
                background: variable("white"),
                // ...
            },
            borderRadius: {
                none: "0",
                sm: "0.125rem",
                DEFAULT: "0.25rem",
                md: "0.275rem",
                lg: "0.375rem",
                full: "9999px",
                large: "12px",
            },
            fontFamily: {
                sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
                mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "Courier New", "monospace"],
            },
        },
    },
    plugins: [],
} satisfies Config;
