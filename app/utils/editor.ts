import { useTheme } from "next-themes";

// Shared Monaco options for the SQL query editors
export const SQL_EDITOR_OPTIONS = {
	minimap: { enabled: false },
	lineNumbers: "on" as const,
	lineNumbersMinChars: 3,
	lineDecorationsWidth: 8,
	glyphMargin: false,
	folding: false,
	scrollBeyondLastLine: false,
	wordWrap: "on" as const,
	fontSize: 12,
	fontFamily: "'Geist Mono', monospace",
	padding: { top: 8 },
};

/**
 * The Monaco theme matching the app theme
 */
export const useMonacoTheme = () => (useTheme().resolvedTheme === "dark" ? "vs-dark" : "light");
