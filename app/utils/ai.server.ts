import { normalizeBaseUrl, type ProviderSummary } from "./ai";

export interface ProviderSettings {
	apiKey?: string;
	model?: string;
}

type UserAiFields = { aiProviders?: string | null; openAiApiKey?: string | null; openAiBaseUrl?: string | null; openAiModel?: string | null };

/**
 * Saved settings per provider, keyed by base URL. The active settings count as saved too,
 * which also covers settings saved before providers were remembered separately.
 */
export function readProviders(user: UserAiFields): Record<string, ProviderSettings> {
	let providers: Record<string, ProviderSettings> = {};
	try {
		const parsed = JSON.parse(user.aiProviders || "{}");
		if (parsed && typeof parsed === "object") providers = parsed;
	} catch {
		// keep empty
	}
	const active = normalizeBaseUrl(user.openAiBaseUrl);
	if (!providers[active] && (user.openAiApiKey || user.openAiModel)) {
		providers[active] = { apiKey: user.openAiApiKey || undefined, model: user.openAiModel || undefined };
	}
	return providers;
}

// Enough of the key to recognise it: "sk-…a1b2"
export const keyHint = (key: string) => (key.length <= 10 ? "••••" : `${key.slice(0, 3)}…${key.slice(-4)}`);

export const providerSummaries = (user: UserAiFields): ProviderSummary[] =>
	Object.entries(readProviders(user)).map(([baseUrl, settings]) => ({ baseUrl, model: settings.model, keyHint: settings.apiKey ? keyHint(settings.apiKey) : undefined }));
