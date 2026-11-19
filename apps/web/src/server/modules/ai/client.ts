import { randomUUID } from "node:crypto";
/**
 * Wire formats of the two supported provider families: "openai" (OpenAI and every OpenAI-compatible API)
 * and "anthropic". Plain fetch, no SDKs; models are always listed live, nothing names a specific model.
 */
import { type Locale, type MessageKey, msg, type Translatable, t, translate } from "../../../i18n/index.ts";
import { UserError } from "../../errors.ts";
import { listedContextWindow, rememberContextWindow } from "./tokens.ts";

export type ProviderKind = "openai" | "anthropic";
export type ProviderConfig = { kind: ProviderKind; baseUrl: string; apiKey: string; model: string | null; sessionId?: string };
export type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; reported: boolean };
export type ChatMessage = { role: "user" | "assistant"; content: string };
/** `input` is the parsed arguments, or the raw text when the model sent no valid JSON. */
export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { id: string; content: string; isError: boolean };
export type Message = ChatMessage | { role: "assistant"; content: string; toolCalls: ToolCall[] } | { role: "tool"; results: ToolResult[] };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};
export type ProviderPreset = {
  id: "openai" | "anthropic" | "opencode" | "opencode-go" | "ollama" | "custom";
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  keyRequired: boolean;
  hint: string;
};

const PRESETS: (Omit<ProviderPreset, "label" | "hint"> & { label: string | null; hint: MessageKey })[] = [
  { id: "openai", label: "OpenAI", kind: "openai", baseUrl: DEFAULT_BASE_URLS.openai, keyRequired: true, hint: "ai.presets.openai" },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: DEFAULT_BASE_URLS.anthropic,
    keyRequired: true,
    hint: "ai.presets.anthropic",
  },
  {
    id: "opencode",
    label: "OpenCode Zen",
    kind: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
    keyRequired: true,
    hint: "ai.presets.opencode",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    kind: "openai",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    keyRequired: true,
    hint: "ai.presets.opencodeGo",
  },
  {
    id: "ollama",
    label: "Ollama",
    kind: "openai",
    baseUrl: "http://host.docker.internal:11434/v1",
    keyRequired: false,
    hint: "ai.presets.ollama",
  },
  { id: "custom", label: null, kind: "openai", baseUrl: "", keyRequired: false, hint: "ai.presets.custom" },
];

/** Ready-made settings in the reader's language; every URL stays editable, "custom" starts empty. */
export function providerPresets(locale: Locale): ProviderPreset[] {
  return PRESETS.map((p) => ({ ...p, label: p.label ?? t(locale, "ai.presets.customLabel"), hint: translate(locale, p.hint) }));
}

const ANTHROPIC_VERSION = "2023-06-01";
const NON_CHAT_MARKERS = [
  "embedding",
  "whisper",
  "tts",
  "dall-e",
  "davinci",
  "babbage",
  "moderation",
  "image",
  "audio",
  "realtime",
  "transcribe",
  "search",
  "sora",
  "computer-use",
];
const MODELS_TIMEOUT_MS = 15_000;
const COMPLETION_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 4096;

function headers(cfg: ProviderConfig): Record<string, string> {
  // Local servers such as Ollama need no key; then no credential header is sent at all.
  const auth: Record<string, string> =
    cfg.kind === "anthropic"
      ? { ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}), "anthropic-version": ANTHROPIC_VERSION }
      : cfg.apiKey
        ? { Authorization: `Bearer ${cfg.apiKey}` }
        : {};
  return { ...auth, ...sessionHeader(cfg), "content-type": "application/json", accept: "application/json" };
}

/** OpenCode routes requests by a stable id per conversation and rejects completions without one. */
function sessionHeader(cfg: ProviderConfig): Record<string, string> {
  let host = "";
  try {
    host = new URL(cfg.baseUrl).hostname;
  } catch {
    return {};
  }
  if (host !== "opencode.ai" && !host.endsWith(".opencode.ai")) return {};
  return { "x-opencode-session": cfg.sessionId ?? randomUUID() };
}

async function send(cfg: ProviderConfig, path: string, timeoutMs: number, body?: unknown): Promise<Response> {
  try {
    return await fetch(`${cfg.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: headers(cfg),
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect could carry the key to another host.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new UserError(timeout ? msg("ai.errors.timeout") : msg("ai.errors.unreachable"), 502);
  }
}

async function failure(response: Response): Promise<UserError> {
  if (response.status >= 300 && response.status < 400) {
    return new UserError(msg("ai.errors.redirect", { status: String(response.status) }), 502);
  }
  let message = "";
  try {
    const text = await response.text();
    try {
      const error = (JSON.parse(text) as { error?: unknown }).error;
      message = typeof error === "object" && error !== null ? String((error as { message?: unknown }).message ?? "") : String(error ?? "");
    } catch {
      message = text;
    }
  } catch {}
  return new UserError(
    msg("ai.errors.status", { status: String(response.status), message: message.slice(0, 300) || msg("ai.errors.unknown") }),
    502,
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) return body as Record<string, unknown>;
  } catch {}
  throw new UserError(msg("ai.errors.unreadable"), 502);
}

/** Prices per million tokens; every source this app reads quotes USD. */
export type ModelPrice = { inputPerMtok: number; outputPerMtok: number; currency: "USD" };
/** `trainsOnData` / `noRetention` come from OpenCode's model list; other providers do not say. */
export type ModelOption = { id: string; price: ModelPrice | null; trainsOnData?: boolean; noRetention?: boolean; contextWindow?: number };

export const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The base price of an OpenCode entry (`cost.text.input.price`, `cost.text.output.price`); surcharges are ignored. */
function listedPrice(item: unknown): ModelPrice | null {
  const text = (item as { cost?: { text?: { input?: { price?: unknown }; output?: { price?: unknown } } } } | null)?.cost?.text;
  const input = text?.input?.price;
  const output = text?.output?.price;
  return isPrice(input) && isPrice(output) ? { inputPerMtok: input, outputPerMtok: output, currency: "USD" } : null;
}

export async function listModels(cfg: ProviderConfig, includeAll = false): Promise<ModelOption[]> {
  const response = await send(cfg, cfg.kind === "anthropic" ? "/models?limit=1000" : "/models", MODELS_TIMEOUT_MS);
  if (!response.ok) throw await failure(response);
  const data = (await json(response)).data;
  const models = new Map<string, ModelOption>();
  // OpenCode names the interface each model speaks; Saldo only talks chat completions (OpenAI) or messages (Anthropic).
  const wire = cfg.kind === "anthropic" ? "messages" : "chat-completions";
  for (const item of Array.isArray(data) ? data : []) {
    const entry = item as {
      id?: unknown;
      api?: unknown;
      go?: { training?: unknown; zdr?: unknown };
      capabilities?: { tools?: { supported?: unknown } };
    } | null;
    const id = entry?.id;
    if (typeof id !== "string" || !id || models.has(id)) continue;
    const api = entry?.api;
    if (!includeAll && api && typeof api === "object" && !(wire in api)) continue;
    const option: ModelOption = { id, price: listedPrice(item) };
    if (entry?.go?.training === true) option.trainsOnData = true;
    if (entry?.go?.zdr === true) option.noRetention = true;
    const tools = entry?.capabilities?.tools?.supported;
    if (typeof tools === "boolean") rememberToolSupport({ ...cfg, model: id }, tools);
    const window = listedContextWindow(item);
    if (window !== null) {
      option.contextWindow = window;
      rememberContextWindow(cfg, id, window);
    }
    models.set(id, option);
  }
  const sorted = [...models.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return includeAll ? sorted : sorted.filter(({ id }) => !NON_CHAT_MARKERS.some((marker) => id.toLowerCase().includes(marker)));
}

/** Some providers (OpenCode) list their models without credentials, so a model list proves nothing about the key. */
export async function modelsArePublic(cfg: ProviderConfig): Promise<boolean> {
  if (!cfg.apiKey) return false;
  try {
    const response = await send({ ...cfg, apiKey: "" }, cfg.kind === "anthropic" ? "/models?limit=1000" : "/models", MODELS_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}

export type KeyCheck = { result: "valid" | "rejected" | "unknown"; detail: Translatable | string };

/** Smallest authenticated request (one output token) that proves the key is accepted. */
export async function checkKey(cfg: ProviderConfig, model: string): Promise<KeyCheck> {
  const messages = [{ role: "user", content: "ping" }];
  let response: Response;
  try {
    response =
      cfg.kind === "anthropic"
        ? await send(cfg, "/messages", MODELS_TIMEOUT_MS, { model, max_tokens: 1, messages })
        : await send(cfg, "/chat/completions", MODELS_TIMEOUT_MS, { model, max_tokens: 1, messages });
  } catch (error) {
    return { result: "unknown", detail: error instanceof UserError ? error.text : msg("ai.errors.unknown") };
  }
  if (response.ok) return { result: "valid", detail: "" };
  const { text } = await failure(response);
  if (response.status === 401 || response.status === 403) return { result: "rejected", detail: text };
  // Any other client error came after authentication, e.g. a model restricted to other regions: the key itself works.
  if (response.status >= 400 && response.status < 500) return { result: "valid", detail: text };
  return { result: "unknown", detail: text };
}

const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);

export function usageFromResponse(kind: ProviderKind, body: Record<string, unknown>): Usage {
  const raw = body.usage as Record<string, unknown> | undefined;
  if (typeof raw !== "object" || raw === null) return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reported: false };
  if (kind === "anthropic") {
    const cached = count(raw.cache_read_input_tokens);
    const created = count(raw.cache_creation_input_tokens);
    return {
      inputTokens: count(raw.input_tokens) + cached + created,
      outputTokens: count(raw.output_tokens),
      cachedInputTokens: cached,
      reported: true,
    };
  }
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: count(raw.prompt_tokens),
    outputTokens: count(raw.completion_tokens),
    cachedInputTokens: typeof details === "object" && details !== null ? count(details.cached_tokens) : 0,
    reported: "prompt_tokens" in raw || "completion_tokens" in raw,
  };
}

// ---- tool support

const withoutTools = new Set<string>();
const modelKey = (cfg: ProviderConfig) => `${cfg.kind}|${cfg.baseUrl}|${cfg.model ?? ""}`;

/** Learned from model lists (OpenCode names it) and from providers rejecting `tools`; kept until the process restarts. */
export function rememberToolSupport(cfg: ProviderConfig, supported: boolean): void {
  if (supported) withoutTools.delete(modelKey(cfg));
  else withoutTools.add(modelKey(cfg));
}

export const toolsUnsupported = (cfg: ProviderConfig) => withoutTools.has(modelKey(cfg));

export function resetToolSupportForTests(): void {
  withoutTools.clear();
}

/** The provider answered 400 to a request with `tools`: the model or API cannot call functions. */
export class ToolsRejected extends UserError {}

// ---- completions

export type CompletionRequest = {
  system: string;
  messages: Message[];
  jsonMode: boolean;
  sessionId?: string;
  tools?: ToolSpec[];
  /** "none" asks for a text answer while earlier tool turns stay readable. */
  toolChoice?: "auto" | "none";
};
export type Completion = { text: string; usage: Usage; toolCalls: ToolCall[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function anthropicMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      };
    }
    if ("toolCalls" in m) {
      return {
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: isRecord(c.input) ? c.input : {} })),
        ],
      };
    }
    return m;
  });
}

function openAiMessages(messages: Message[]): unknown[] {
  return messages.flatMap((m): unknown[] => {
    if (m.role === "tool") return m.results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.content }));
    if ("toolCalls" in m) {
      return [
        {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {}) },
          })),
        },
      ];
    }
    return [m];
  });
}

/** One provider call. Usage is returned even when the text turns out unusable, so the caller can meter it. */
export async function complete(base: ProviderConfig, request: CompletionRequest): Promise<Completion> {
  const cfg: ProviderConfig = request.sessionId ? { ...base, sessionId: request.sessionId } : base;
  if (!cfg.model) throw new UserError(msg("ai.errors.chooseModel"));
  const tools = request.tools && request.tools.length > 0 ? request.tools : null;
  const rejected = async (response: Response) => {
    const error = await failure(response);
    return tools && response.status === 400 ? new ToolsRejected(error.text, error.status) : error;
  };
  if (cfg.kind === "anthropic") {
    const response = await send(cfg, "/messages", COMPLETION_TIMEOUT_MS, {
      model: cfg.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: request.system,
      messages: anthropicMessages(request.messages),
      ...(tools
        ? {
            tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
            tool_choice: { type: request.toolChoice ?? "auto" },
          }
        : {}),
    });
    if (!response.ok) throw await rejected(response);
    const body = await json(response);
    const content = Array.isArray(body.content) ? (body.content as Record<string, unknown>[]) : [];
    const text = content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
    const toolCalls = content.flatMap((part, i) =>
      part?.type === "tool_use" && typeof part.name === "string"
        ? [{ id: typeof part.id === "string" ? part.id : `call_${i}`, name: part.name, input: part.input ?? {} }]
        : [],
    );
    return { text, usage: usageFromResponse(cfg.kind, body), toolCalls };
  }
  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: "system", content: request.system }, ...openAiMessages(request.messages)],
  };
  if (tools) {
    payload.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    payload.tool_choice = request.toolChoice ?? "auto";
  }
  if (request.jsonMode) payload.response_format = { type: "json_object" };
  let response = await send(cfg, "/chat/completions", COMPLETION_TIMEOUT_MS, payload);
  if (response.status === 400 && request.jsonMode) {
    // Some OpenAI-compatible APIs reject response_format; the prompt still asks for JSON.
    delete payload.response_format;
    response = await send(cfg, "/chat/completions", COMPLETION_TIMEOUT_MS, payload);
  }
  if (!response.ok) throw await rejected(response);
  const body = await json(response);
  const choices = Array.isArray(body.choices) ? (body.choices as { message?: { content?: unknown; tool_calls?: unknown } }[]) : [];
  const message = choices[0]?.message;
  const calls = Array.isArray(message?.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : [];
  const toolCalls = calls.flatMap((call, i) => {
    const fn = isRecord(call?.function) ? call.function : null;
    return fn && typeof fn.name === "string"
      ? [{ id: typeof call.id === "string" && call.id ? call.id : `call_${i}`, name: fn.name, input: parseArguments(fn.arguments) }]
      : [];
  });
  return { text: typeof message?.content === "string" ? message.content : "", usage: usageFromResponse(cfg.kind, body), toolCalls };
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new UserError(msg("ai.errors.noJson"), 502);
  try {
    const value: unknown = JSON.parse(match[0]);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  throw new UserError(msg("ai.errors.invalidJson"), 502);
}
