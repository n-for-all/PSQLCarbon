import { useState } from "react";
import { Form } from "@remix-run/react";
import { ArrowRightIcon, CheckCircleFillIcon, SyncIcon } from "@primer/octicons-react";
import { Button } from "~/ui/button";
import { Input } from "~/ui/input";
import { AI_PRESETS, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, normalizeBaseUrl, type ProviderSummary } from "~/utils/ai";

interface AiSettingsFormProps {
    baseUrl: string | null | undefined;
    model: string | null | undefined;
    /** Every provider used before, with its model and a hint of its key */
    providers: ProviderSummary[];
}

/**
 * Settings for any OpenAI compatible server, hosted (DeepSeek, OpenAI ...) or local (LM Studio, Ollama ...).
 * Each provider keeps its own key and model, switching between them brings those back.
 */
export const AiSettingsForm = ({ baseUrl: savedBaseUrl, model: savedModel, providers }: AiSettingsFormProps) => {
    const [baseUrl, setBaseUrl] = useState(savedBaseUrl || "");
    const [model, setModel] = useState(savedModel || DEFAULT_AI_MODEL);
    const [apiKey, setApiKey] = useState("");
    const [models, setModels] = useState<string[] | null>(null);
    const [modelsState, setModelsState] = useState<{ loading?: boolean; error?: string }>({});

    const effectiveUrl = normalizeBaseUrl(baseUrl);
    const activeUrl = normalizeBaseUrl(savedBaseUrl);
    const saved = providers.find((provider) => provider.baseUrl === effectiveUrl);
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(effectiveUrl);

    const loadModels = async (url = effectiveUrl) => {
        setModelsState({ loading: true });
        try {
            const response = await fetch("/api/ai-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: url, apiKey }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message);
            setModels(data.models);
            setModelsState({});
            // Pick a model when the current one isn't offered by this server
            if (data.models.length) setModel((current) => (data.models.includes(current) ? current : data.models[0]));
        } catch (error: any) {
            setModels(null);
            setModelsState({ error: error.message });
        }
    };

    const selectProvider = (url: string, defaultModel: string) => {
        const normalized = normalizeBaseUrl(url);
        const previous = providers.find((provider) => provider.baseUrl === normalized);
        setBaseUrl(url);
        setApiKey("");
        setModel(previous?.model || defaultModel);
        setModels(null);
        setModelsState({});
        // Local servers and providers with a saved key can list their models right away
        if (previous?.keyHint || /localhost|127\.0\.0\.1/.test(url)) loadModels(normalized);
    };

    return (
        <div className="flex flex-col gap-5 mb-2">
            <div>
                <span className="block mb-1.5 text-sm">Provider</span>
                <div className="flex flex-wrap gap-2">
                    {AI_PRESETS.map((preset) => {
                        const known = providers.find((provider) => provider.baseUrl === normalizeBaseUrl(preset.baseUrl));
                        const selected = effectiveUrl === normalizeBaseUrl(preset.baseUrl);
                        return (
                            <button
                                key={preset.name}
                                type="button"
                                onClick={() => selectProvider(preset.baseUrl, preset.model)}
                                title={known ? `Saved: ${known.model || "no model"}${known.keyHint ? `, key ${known.keyHint}` : ""}` : undefined}
                                className={`flex items-center gap-1 px-3 py-1.5 text-xs border ${selected ? "border-primary bg-blue-50 text-neutral-900" : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50"}`}>
                                {preset.name}
                                {!preset.needsKey && <span className="text-neutral-400">(local)</span>}
                                {(known?.keyHint || (known && !preset.needsKey)) && <CheckCircleFillIcon size={10} className="text-green-600" />}
                                {normalizeBaseUrl(preset.baseUrl) === activeUrl && <span className="text-[10px] text-primary">active</span>}
                            </button>
                        );
                    })}
                </div>
                <span className="block mt-1 text-xs text-neutral-500">
                    Each provider keeps its own key and model. Any OpenAI compatible server works, local ones (LM Studio, Ollama, llama.cpp, vLLM ...) need no API key.
                </span>
            </div>

            <Form method="post" autoComplete="off" className="flex flex-col gap-5">
                <input type="hidden" name="intent" value="update_ai_settings" />
                <input type="hidden" name="openAiBaseUrl" value={baseUrl.trim()} />
                <input type="hidden" name="openAiModel" value={model.trim()} />
                <Input
                    id="openAiBaseUrl"
                    labelText="API Base URL"
                    type="text"
                    autoComplete="off"
                    value={baseUrl}
                    onChange={(e) => {
                        setBaseUrl(e.target.value);
                        setModels(null);
                    }}
                    placeholder={DEFAULT_AI_BASE_URL}
                />
                <div>
                    <Input
                        id="openAiApiKey"
                        name="openAiApiKey"
                        labelText={isLocal ? "API Key (not needed for local servers)" : "API Key"}
                        autoComplete="new-password"
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={saved?.keyHint ? `Saved key ${saved.keyHint}, leave empty to keep it` : isLocal ? "Leave empty" : "sk-..."}
                    />
                    {saved?.keyHint && !apiKey && (
                        <span className="flex items-center gap-2 mt-1.5 text-xs text-neutral-600">
                            <span>
                                Saved key for this provider: <span className="font-mono text-neutral-900">{saved.keyHint}</span>
                            </span>
                        </span>
                    )}
                </div>
                <div>
                    <div className="flex items-end gap-2">
                        <div className="flex-1">
                            {models && models.length > 0 ? (
                                <label className="block">
                                    <span className="block mb-1.5 text-sm">Model</span>
                                    <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full px-3 py-2 text-sm bg-white border-b border-neutral-900">
                                        {models.map((id) => (
                                            <option key={id} value={id}>
                                                {id}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            ) : (
                                <Input id="openAiModel" labelText="Model Name" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder={DEFAULT_AI_MODEL} />
                            )}
                        </div>
                        <Button size="sm" variant="outline" type="button" icon={<SyncIcon />} loading={modelsState.loading} onClick={() => loadModels()}>
                            Load models
                        </Button>
                    </div>
                    {models && models.length === 0 && <span className="block mt-1 text-xs text-amber-700">The server has no chat models loaded.</span>}
                    {modelsState.error && <span className="block mt-1 text-xs text-red-600 break-words">{modelsState.error}</span>}
                    {isLocal && <span className="block mt-1 text-xs text-neutral-500">Models that support tool calling work best, the assistant uses tools to run queries.</span>}
                </div>
                <Button size="sm" icon={<ArrowRightIcon />} type="submit" disabled={!model.trim()}>
                    {effectiveUrl === activeUrl ? "Update AI Settings" : "Save and use this provider"}
                </Button>
            </Form>

            {saved?.keyHint && (
                <Form method="post" className="-mt-2">
                    <input type="hidden" name="intent" value="forget_ai_key" />
                    <input type="hidden" name="openAiBaseUrl" value={effectiveUrl} />
                    <button
                        type="submit"
                        className="text-xs text-neutral-500 underline hover:text-red-600"
                        onClick={(e) => {
                            if (!window.confirm(`Forget the saved key ${saved.keyHint} for ${effectiveUrl}?`)) e.preventDefault();
                        }}>
                        Forget the saved key for this provider
                    </button>
                </Form>
            )}
        </div>
    );
};
