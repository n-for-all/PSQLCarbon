// Defaults for the AI assistant, any OpenAI compatible endpoint can be configured from the profile page
export const DEFAULT_AI_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_AI_MODEL = "deepseek-flash";

/**
 * The assistant works once it has an API key, or a server of its own (LM Studio, Ollama ... need no key)
 */
export const isAiConfigured = (settings: { openAiApiKey?: string | null; openAiBaseUrl?: string | null } | null | undefined) =>
	!!(settings?.openAiApiKey || settings?.openAiBaseUrl?.trim());

export const AI_NOT_CONFIGURED = "Set up the AI assistant in Profile settings: an API key, or the address of a local server like LM Studio or Ollama.";

export const AI_PRESETS = [
	{ name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", needsKey: true },
	{ name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "", needsKey: true },
	{ name: "LM Studio", baseUrl: "http://localhost:1234/v1", model: "", needsKey: false },
	{ name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "", needsKey: false },
];

/**
 * Base URLs compare equal however they were typed, an empty one means the default provider
 */
export const normalizeBaseUrl = (url?: string | null) => (url?.trim() || DEFAULT_AI_BASE_URL).replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");

/** What the browser gets to see of a saved provider, never the key itself */
export interface ProviderSummary {
	baseUrl: string;
	model?: string;
	keyHint?: string;
}
