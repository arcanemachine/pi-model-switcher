import {
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export interface ModelAliasPreset {
  model: string;
  thinkingLevel: ModelThinkingLevel;
}

export interface ModelSwitcherSettings {
  allowed?: boolean;
  allow?: "all" | string[];
  aliases?: Record<string, ModelAliasPreset>;
}

export type PermissionSource = "default" | "config" | "flag" | "session";
export type PermissionOverride = boolean | null;
export type PermissionAllowPolicy = "all" | string[];

export interface ResolvedConfiguration {
  allowed: boolean | undefined;
  allow: PermissionAllowPolicy;
  aliases: Record<string, ModelAliasPreset>;
}

export interface PermissionResolution {
  allowed: boolean;
  source: PermissionSource;
}

export interface PermissionEntry {
  version: 1;
  override: "allowed" | "denied" | "reset";
}

export interface CandidateModel {
  model: NonNullable<ExtensionContext["model"]>;
  thinkingLevel?: NonNullable<
    ExtensionContext["scopedModels"]
  >[number]["thinkingLevel"];
}

export interface CandidateCalculation {
  availableModels: CandidateModel["model"][];
  nativeCandidates: CandidateModel[];
  candidates: CandidateModel[];
}

export interface ModelAlias {
  alias: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
}

export interface ModelListDetails {
  current?: string;
  returned: string[];
  totalMatches: number;
  truncated: boolean;
  noModelsReason?: "scope" | "query" | "available";
  aliases: Record<string, ModelAliasPreset>;
  totalAliasMatches: number;
  aliasesTruncated: boolean;
  refreshFallback: boolean;
}

const SETTINGS_KEY = "model-switcher";
const FLAG_ALLOW = "model-switcher-allow";
const FLAG_DENY = "model-switcher-deny";
const PERMISSION_ENTRY_TYPE = "pi-model-switcher:permission";
const PERMISSION_CHANGE_MESSAGE_TYPE = "pi-model-switcher:permission-change";
const REFRESH_TIMEOUT_MS = 15_000;

export const MODEL_SWITCHER_PERMISSION_GUIDANCE =
  "Agent-driven model switching is denied for this session. Only the user can allow it with /model-switcher allow. If the user asked you to switch models, ask them to allow it; otherwise do not retry model_switcher_list or model_switcher.";

const ALLOWED_MESSAGE =
  "Agent-driven model switching is now allowed for this session. You may use model_switcher_list and model_switcher when appropriate.";
const DENIED_MESSAGE =
  "Agent-driven model switching is now denied for this session. Do not use model_switcher_list or model_switcher unless the user allows it again.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Normalize and validate one exact provider/model identifier. */
export function normalizeCanonicalIdentifier(
  value: string,
): string | undefined {
  const trimmed = value.trim();
  if (/[*?\[\]]/.test(trimmed)) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;

  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!provider || !modelId) return undefined;
  return `${provider}/${modelId}`;
}

/** Normalize one lowercase alias name. */
export function normalizeAliasName(value: string): string | undefined {
  const trimmed = value.trim();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(trimmed) ? trimmed : undefined;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return (
    typeof value === "string" &&
    THINKING_LEVELS.includes(value as ModelThinkingLevel)
  );
}

/** Normalize strict model-and-thinking alias presets; invalid entries are ignored. */
export function normalizeAliases(
  raw: unknown,
  warnings: string[] = [],
): Record<string, ModelAliasPreset> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    warnings.push("model-switcher: invalid aliases setting; aliases ignored.");
    return {};
  }

  const aliases: Record<string, ModelAliasPreset> = {};
  for (const [rawName, rawPreset] of Object.entries(raw)) {
    const name = normalizeAliasName(rawName);
    if (!name || !isRecord(rawPreset)) {
      warnings.push(
        `model-switcher: invalid alias entry "${rawName}"; entry ignored.`,
      );
      continue;
    }
    const keys = Object.keys(rawPreset);
    if (
      keys.length !== 2 ||
      !hasOwn(rawPreset, "model") ||
      !hasOwn(rawPreset, "thinkingLevel")
    ) {
      warnings.push(
        `model-switcher: alias "${name}" must contain only model and thinkingLevel; entry ignored.`,
      );
      continue;
    }
    const target =
      typeof rawPreset.model === "string"
        ? normalizeCanonicalIdentifier(rawPreset.model)
        : undefined;
    if (!target) {
      warnings.push(
        `model-switcher: invalid alias model for "${name}"; entry ignored.`,
      );
      continue;
    }
    if (!isThinkingLevel(rawPreset.thinkingLevel)) {
      warnings.push(
        `model-switcher: invalid alias thinkingLevel for "${name}"; entry ignored.`,
      );
      continue;
    }
    if (hasOwn(aliases, name)) {
      warnings.push(
        `model-switcher: duplicate alias "${name}"; later entry ignored.`,
      );
      continue;
    }
    aliases[name] = { model: target, thinkingLevel: rawPreset.thinkingLevel };
  }
  return aliases;
}

function normalizeAllowPolicy(raw: unknown): {
  allow: PermissionAllowPolicy;
  invalidType: boolean;
  invalidEntries: number;
} {
  if (raw === undefined) {
    return { allow: "all", invalidType: false, invalidEntries: 0 };
  }
  if (raw === "all") {
    return { allow: "all", invalidType: false, invalidEntries: 0 };
  }
  if (!Array.isArray(raw)) {
    return { allow: [], invalidType: true, invalidEntries: 0 };
  }

  const valid: string[] = [];
  let invalidEntries = 0;
  for (const entry of raw) {
    if (typeof entry !== "string") {
      invalidEntries++;
      continue;
    }
    const normalized = normalizeCanonicalIdentifier(entry);
    if (!normalized) {
      invalidEntries++;
      continue;
    }
    if (!valid.includes(normalized)) valid.push(normalized);
  }
  return { allow: valid, invalidType: false, invalidEntries };
}

/** Normalize an allow setting; invalid values fail closed to an empty set. */
export function normalizeAllowlist(raw: unknown): PermissionAllowPolicy {
  return normalizeAllowPolicy(raw).allow;
}

/** Resolve the extension namespace after global/project settings have been loaded. */
export function resolveConfiguration(
  globalSettings: unknown,
  projectSettings: unknown,
  projectTrusted = true,
  warnings: string[] = [],
): ResolvedConfiguration {
  const global = isRecord(globalSettings) ? globalSettings : {};
  const project = isRecord(projectSettings) ? projectSettings : {};
  const globalHasNamespace = hasOwn(global, SETTINGS_KEY);
  const projectHasNamespace = projectTrusted && hasOwn(project, SETTINGS_KEY);
  const globalNamespace = globalHasNamespace ? global[SETTINGS_KEY] : undefined;
  const projectNamespace = projectHasNamespace
    ? project[SETTINGS_KEY]
    : undefined;

  if (globalHasNamespace && !isRecord(globalNamespace)) {
    warnings.push("model-switcher: invalid settings namespace; denied.");
    return { allowed: false, allow: [], aliases: {} };
  }
  if (projectHasNamespace && !isRecord(projectNamespace)) {
    warnings.push("model-switcher: invalid settings namespace; denied.");
    return { allowed: false, allow: [], aliases: {} };
  }

  const merged: Record<string, unknown> = {
    ...(isRecord(globalNamespace) ? globalNamespace : {}),
    ...(isRecord(projectNamespace) ? projectNamespace : {}),
  };

  let allowed: boolean | undefined;
  if (hasOwn(merged, "allowed")) {
    if (typeof merged.allowed === "boolean") {
      allowed = merged.allowed;
    } else {
      warnings.push("model-switcher: invalid allowed setting; denied.");
      allowed = false;
    }
  }

  const allowResult = normalizeAllowPolicy(merged.allow);
  if (allowResult.invalidType) {
    warnings.push(
      "model-switcher: invalid allow setting; no models permitted.",
    );
  } else if (allowResult.invalidEntries > 0) {
    warnings.push(
      "model-switcher: invalid allowlist entries ignored; valid entries retained.",
    );
  }

  return {
    allowed,
    allow: allowResult.allow,
    aliases: normalizeAliases(merged.aliases, warnings),
  };
}

export function resolvePermission(
  configuration: ResolvedConfiguration,
  sessionOverride: PermissionOverride,
  flagAllow: boolean,
  flagDeny: boolean,
): PermissionResolution {
  if (sessionOverride !== null) {
    return { allowed: sessionOverride, source: "session" };
  }
  if (flagDeny || flagAllow) {
    return { allowed: !flagDeny, source: "flag" };
  }
  if (configuration.allowed !== undefined) {
    return { allowed: configuration.allowed, source: "config" };
  }
  return { allowed: false, source: "default" };
}

export function formatPermissionStatus(
  permission: PermissionResolution,
  hasAllowedModels: boolean,
): string {
  const state = permission.allowed ? "allowed" : "denied";
  const source =
    permission.source === "default" ? "" : ` · source: ${permission.source}`;
  const empty =
    permission.allowed && !hasAllowedModels ? " · allowed models: none" : "";
  return `Agent-driven model switching: ${state}${source}${empty}`;
}

function permissionEntryFromData(data: unknown): PermissionEntry | undefined {
  if (!isRecord(data) || data.version !== 1) return undefined;
  if (
    data.override !== "allowed" &&
    data.override !== "denied" &&
    data.override !== "reset"
  ) {
    return undefined;
  }
  return data as unknown as PermissionEntry;
}

/** Find the newest valid permission entry on an active branch. */
export function findLatestPermissionEntry(
  entries: readonly unknown[],
): PermissionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom") continue;
    if (entry.customType !== PERMISSION_ENTRY_TYPE) continue;
    const permission = permissionEntryFromData(entry.data);
    if (permission) return permission;
  }
  return undefined;
}

function permissionOverrideFromEntry(
  entry: PermissionEntry | undefined,
): PermissionOverride {
  if (!entry || entry.override === "reset") return null;
  return entry.override === "allowed";
}

function canonicalModel(model: CandidateModel["model"]): string {
  return `${model.provider}/${model.id}`;
}

function displayName(model: CandidateModel["model"]): string {
  return typeof model.name === "string" ? model.name.trim() : "";
}

function sortCandidates(candidates: CandidateModel[]): CandidateModel[] {
  return [...candidates].sort((left, right) => {
    const providerOrder = left.model.provider.localeCompare(
      right.model.provider,
    );
    return providerOrder || left.model.id.localeCompare(right.model.id);
  });
}

/** Build candidates from Pi's current native scope, then apply the exact extension allowlist. */
export function calculateCandidates(
  ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">,
  allow: PermissionAllowPolicy,
  availableModels?: readonly CandidateModel["model"][],
): CandidateCalculation {
  const available = [
    ...(availableModels ?? ctx.modelRegistry.getAvailable()),
  ] as CandidateModel["model"][];
  const byCanonical = new Map(
    available.map((model) => [canonicalModel(model), model]),
  );

  const nativeCandidates: CandidateModel[] = [];
  if (ctx.scopedModels.length > 0) {
    const seen = new Set<string>();
    for (const scoped of ctx.scopedModels) {
      const key = canonicalModel(scoped.model);
      if (seen.has(key)) continue;
      const refreshed = byCanonical.get(key);
      if (!refreshed) continue;
      seen.add(key);
      nativeCandidates.push({
        model: refreshed,
        ...(scoped.thinkingLevel !== undefined
          ? { thinkingLevel: scoped.thinkingLevel }
          : {}),
      });
    }
  } else {
    nativeCandidates.push(...available.map((model) => ({ model })));
  }

  const candidates = sortCandidates(
    allow === "all"
      ? nativeCandidates
      : nativeCandidates.filter((candidate) =>
          allow.includes(canonicalModel(candidate.model)),
        ),
  );
  return { availableModels: available, nativeCandidates, candidates };
}

/** Return configured aliases in deterministic name order. */
export function calculateAliases(
  aliases: Readonly<Record<string, ModelAliasPreset>>,
): ModelAlias[] {
  return Object.entries(aliases)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias, preset]) => ({ alias, ...preset }));
}

interface RefreshOutcome {
  fallback: boolean;
  reason?: "timeout" | "failure" | "aborted";
}

async function refreshModels(
  registry: ExtensionContext["modelRegistry"],
  signal: AbortSignal | undefined,
): Promise<RefreshOutcome> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeCallerListener: (() => void) | undefined;
  let removeAbortRaceListener: (() => void) | undefined;

  if (signal) {
    if (signal.aborted) controller.abort();
    else {
      signal.addEventListener("abort", abortFromCaller, { once: true });
      removeCallerListener = () =>
        signal.removeEventListener("abort", abortFromCaller);
    }
  }

  try {
    const refreshPromise = Promise.resolve().then(() =>
      registry.refresh({ signal: controller.signal }),
    );
    const timeoutPromise = new Promise<RefreshOutcome>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve({ fallback: true, reason: "timeout" });
      }, REFRESH_TIMEOUT_MS);
    });
    const abortPromise = signal
      ? new Promise<RefreshOutcome>((resolve) => {
          if (signal.aborted) {
            resolve({ fallback: true, reason: "aborted" });
            return;
          }
          const onAbort = () => {
            controller.abort();
            resolve({ fallback: true, reason: "aborted" });
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortRaceListener = () =>
            signal.removeEventListener("abort", onAbort);
        })
      : undefined;

    const result = await Promise.race([
      refreshPromise.then((value) => ({ result: value })),
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ]);
    if ("fallback" in result) return result;
    const refreshResult = result.result;
    if (
      refreshResult &&
      (refreshResult.aborted || refreshResult.errors?.size > 0)
    ) {
      return {
        fallback: true,
        reason: refreshResult.aborted ? "aborted" : "failure",
      };
    }
    return { fallback: false };
  } catch {
    return { fallback: true, reason: "failure" };
  } finally {
    if (timeout) clearTimeout(timeout);
    removeCallerListener?.();
    removeAbortRaceListener?.();
    controller.abort();
  }
}

function refreshNote(outcome: RefreshOutcome): string | undefined {
  if (!outcome.fallback) return undefined;
  if (outcome.reason === "timeout") {
    return "Note: model refresh timed out; showing cached models.";
  }
  if (outcome.reason === "aborted") {
    return "Note: model refresh was cancelled; showing cached models.";
  }
  return "Note: model refresh failed; showing cached models.";
}

function noModelsReason(
  calculation: CandidateCalculation,
  query: string,
): ModelListDetails["noModelsReason"] {
  if (query && calculation.candidates.length > 0) return "query";
  if (calculation.candidates.length === 0) {
    return calculation.availableModels.length === 0 ? "available" : "scope";
  }
  return undefined;
}

function formatCandidate(candidate: CandidateModel): string {
  const canonical = canonicalModel(candidate.model);
  const name = displayName(candidate.model);
  return name && name !== candidate.model.id && name !== canonical
    ? `- ${canonical} — ${name}`
    : `- ${canonical}`;
}

function formatAlias(alias: ModelAlias): string {
  return `- ${alias.alias} → ${alias.model} · thinking: ${alias.thinkingLevel}`;
}

export function formatConfiguredAliases(
  aliases: Readonly<Record<string, ModelAliasPreset>>,
): string {
  const entries = Object.entries(aliases).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return "No model aliases configured.";
  return [
    "Model aliases:",
    ...entries.map(
      ([alias, preset]) =>
        `- ${alias} → ${preset.model} · thinking: ${preset.thinkingLevel}`,
    ),
  ].join("\n");
}

export function formatModelList(
  current: string | undefined,
  candidates: readonly CandidateModel[],
  totalMatches: number,
  query: string,
  refreshFallback: boolean,
  emptyReason?: ModelListDetails["noModelsReason"],
  aliases: readonly ModelAlias[] = [],
  totalAliasMatches = aliases.length,
): { text: string; details: ModelListDetails } {
  const limited = candidates.slice(0, 200);
  const limitedAliases = aliases.slice(0, 200);
  const details: ModelListDetails = {
    ...(current ? { current } : {}),
    returned: limited.map((candidate) => canonicalModel(candidate.model)),
    totalMatches,
    truncated: totalMatches > limited.length,
    aliases: Object.fromEntries(
      limitedAliases.map(({ alias, model, thinkingLevel }) => [
        alias,
        { model, thinkingLevel },
      ]),
    ),
    totalAliasMatches,
    aliasesTruncated: totalAliasMatches > limitedAliases.length,
    refreshFallback,
    ...(totalMatches === 0
      ? {
          noModelsReason:
            emptyReason ??
            noModelsReason(
              {
                availableModels: [],
                nativeCandidates: [],
                candidates: [...candidates],
              },
              query,
            ),
        }
      : {}),
  };

  const lines: string[] = [`Current: ${current ?? "unavailable"}`];
  lines.push(`Aliases (${totalAliasMatches}):`);
  if (limitedAliases.length > 0) lines.push(...limitedAliases.map(formatAlias));
  if (totalAliasMatches === 0) {
    lines.push(
      query ? "No aliases match the query." : "No aliases configured.",
    );
  }
  if (totalAliasMatches > limitedAliases.length) {
    lines.push(
      `Showing ${limitedAliases.length} of ${totalAliasMatches} aliases; call model_switcher_list with a narrower query.`,
    );
  }

  lines.push(`Available models (${totalMatches}):`);
  if (limited.length > 0) lines.push(...limited.map(formatCandidate));
  if (totalMatches > limited.length) {
    lines.push(
      `Showing ${limited.length} of ${totalMatches} models; call model_switcher_list with a narrower query.`,
    );
  }
  if (totalMatches === 0) {
    lines.push(
      details.noModelsReason === "query"
        ? "No models match the query."
        : details.noModelsReason === "available"
          ? "No currently available/authenticated models."
          : "No models permitted by current native scope/allow policy.",
    );
  }
  return { text: lines.join("\n"), details };
}

function reportWarning(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else console.warn(message);
}

function loadConfiguration(ctx: ExtensionContext): ResolvedConfiguration {
  const warnings: string[] = [];
  try {
    const trusted = ctx.isProjectTrusted();
    const manager = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: trusted,
    });
    const managerErrors = manager.drainErrors();
    if (managerErrors.length > 0) {
      reportWarning(ctx, "model-switcher: settings could not be read; denied.");
      return { allowed: false, allow: [], aliases: {} };
    }
    const configuration = resolveConfiguration(
      manager.getGlobalSettings(),
      manager.getProjectSettings(),
      trusted,
      warnings,
    );
    for (const warning of warnings) reportWarning(ctx, warning);
    return configuration;
  } catch {
    reportWarning(ctx, "model-switcher: settings could not be read; denied.");
    return { allowed: false, allow: [], aliases: {} };
  }
}

interface RuntimeState {
  configuration: ResolvedConfiguration;
  sessionOverride: PermissionOverride;
  flagAllow: boolean;
  flagDeny: boolean;
}

function readFlags(
  pi: ExtensionAPI,
): Pick<RuntimeState, "flagAllow" | "flagDeny"> {
  return {
    flagAllow: pi.getFlag(FLAG_ALLOW) === true,
    flagDeny: pi.getFlag(FLAG_DENY) === true,
  };
}

function updateConfiguration(
  pi: ExtensionAPI,
  state: RuntimeState,
  ctx: ExtensionContext,
): void {
  state.configuration = loadConfiguration(ctx);
  Object.assign(state, readFlags(pi));
}

function currentPermission(
  pi: ExtensionAPI,
  state: RuntimeState,
): PermissionResolution {
  return resolvePermission(
    state.configuration,
    state.sessionOverride,
    state.flagAllow,
    state.flagDeny,
  );
}

function assertAuthorized(
  pi: ExtensionAPI,
  state: RuntimeState,
  ctx: ExtensionContext,
): PermissionResolution {
  updateConfiguration(pi, state, ctx);
  const permission = currentPermission(pi, state);
  if (!permission.allowed) throw new Error(MODEL_SWITCHER_PERMISSION_GUIDANCE);
  return permission;
}

function hasAllowedModels(
  ctx: ExtensionContext,
  configuration: ResolvedConfiguration,
): boolean {
  return calculateCandidates(ctx, configuration.allow).candidates.length > 0;
}

function permissionEntry(override: boolean | null): PermissionEntry {
  return {
    version: 1,
    override: override === null ? "reset" : override ? "allowed" : "denied",
  };
}

function setSessionOverride(
  pi: ExtensionAPI,
  state: RuntimeState,
  override: boolean,
): void {
  state.sessionOverride = override;
  pi.appendEntry<PermissionEntry>(
    PERMISSION_ENTRY_TYPE,
    permissionEntry(override),
  );
}

function restoreSessionState(
  pi: ExtensionAPI,
  state: RuntimeState,
  eventReason: "startup" | "reload" | "resume" | "new" | "fork",
  ctx: ExtensionContext,
): void {
  updateConfiguration(pi, state, ctx);
  const branchEntry = findLatestPermissionEntry(ctx.sessionManager.getBranch());
  if (
    eventReason === "startup" ||
    eventReason === "reload" ||
    eventReason === "resume"
  ) {
    state.sessionOverride = permissionOverrideFromEntry(branchEntry);
    return;
  }

  state.sessionOverride = null;
  if (
    eventReason === "fork" &&
    branchEntry &&
    branchEntry.override !== "reset"
  ) {
    pi.appendEntry<PermissionEntry>(
      PERMISSION_ENTRY_TYPE,
      permissionEntry(null),
    );
  }
}

function permissionStatus(
  pi: ExtensionAPI,
  state: RuntimeState,
  ctx: ExtensionContext,
): string {
  updateConfiguration(pi, state, ctx);
  const permission = currentPermission(pi, state);
  return formatPermissionStatus(
    permission,
    hasAllowedModels(ctx, state.configuration),
  );
}

export function modelSwitcherCompletions(
  prefix: string,
): AutocompleteItem[] | null {
  const commands: AutocompleteItem[] = [
    {
      value: "allow",
      label: "allow",
      description: "Allow the agent to list and switch models in this session",
    },
    {
      value: "deny",
      label: "deny",
      description:
        "Deny the agent from listing or switching models in this session",
    },
    {
      value: "aliases",
      label: "aliases",
      description: "Show configured model aliases",
    },
  ];
  const needle = prefix.trimStart().toLowerCase();
  const matches = commands.filter((item) => item.value.startsWith(needle));
  return matches.length > 0 ? matches : null;
}

export default function modelSwitcherExtension(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    configuration: { allowed: undefined, allow: "all", aliases: {} },
    sessionOverride: null,
    flagAllow: false,
    flagDeny: false,
  };

  pi.registerFlag(FLAG_ALLOW, {
    type: "boolean",
    description: "Allow agent-driven model switching for a new session.",
  });
  pi.registerFlag(FLAG_DENY, {
    type: "boolean",
    description: "Deny agent-driven model switching for a new session.",
  });

  pi.registerTool({
    name: "model_switcher_whoami",
    label: "Model Switcher Identity",
    description: "Report the current Pi model and thinking level.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      updateConfiguration(pi, state, ctx);
      const permission = currentPermission(pi, state);
      const current = ctx.model;
      if (!current) throw new Error("No current Pi model is available.");

      const identifier = canonicalModel(current);
      const name = displayName(current);
      const thinking = pi.getThinkingLevel();
      const lines = [`Current model: ${identifier}`];
      if (name && name !== current.id && name !== identifier) {
        lines.push(`Name: ${name}`);
      }
      lines.push(`Thinking: ${thinking}`);
      if (!permission.allowed) {
        lines.push(
          "Agent-driven model switching is not allowed for this session. Do not call model_switcher_list or model_switcher unless the user allows it with /model-switcher allow.",
        );
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          current: identifier,
          model: identifier,
          provider: current.provider,
          modelId: current.id,
          ...(name && name !== current.id && name !== identifier
            ? { name }
            : {}),
          thinking,
          thinkingLevel: thinking,
          switchingAllowed: permission.allowed,
        },
      };
    },
  });

  pi.registerTool({
    name: "model_switcher_list",
    label: "List Models and Aliases",
    description:
      "List available models and configured aliases for model_switcher. Requires user authorization for agent-driven model switching.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertAuthorized(pi, state, ctx);
      const refresh = await refreshModels(ctx.modelRegistry, signal);
      const calculation = calculateCandidates(ctx, state.configuration.allow);
      const aliases = calculateAliases(state.configuration.aliases);
      const query = params.query?.trim().toLowerCase() ?? "";
      const filteredAliases = aliases.filter((alias) => {
        if (!query) return true;
        return (
          alias.alias.toLowerCase().includes(query) ||
          alias.model.toLowerCase().includes(query) ||
          alias.thinkingLevel.toLowerCase().includes(query)
        );
      });
      const filtered = calculation.candidates.filter((candidate) => {
        if (!query) return true;
        const canonical = canonicalModel(candidate.model).toLowerCase();
        return (
          canonical.includes(query) ||
          displayName(candidate.model).toLowerCase().includes(query) ||
          filteredAliases.some(
            (alias) => alias.model.toLowerCase() === canonical,
          )
        );
      });
      const current = ctx.model ? canonicalModel(ctx.model) : undefined;
      const result = formatModelList(
        current,
        filtered,
        filtered.length,
        query,
        refresh.fallback,
        filtered.length === 0 ? noModelsReason(calculation, query) : undefined,
        filteredAliases,
        filteredAliases.length,
      );
      const note = refreshNote(refresh);
      return {
        content: [
          {
            type: "text" as const,
            text: note ? `${result.text}\n${note}` : result.text,
          },
        ],
        details: result.details,
      };
    },
  });

  pi.registerTool({
    name: "model_switcher",
    label: "Switch Model",
    description:
      "Switch this session to an available provider/model or configured alias. Requires user authorization for agent-driven model switching.",
    parameters: Type.Object({
      model: Type.String({
        description:
          "Exact canonical provider/model identifier or configured alias from model_switcher_list.",
      }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      assertAuthorized(pi, state, ctx);
      const requested = params.model.trim();
      const aliasTarget = state.configuration.aliases[requested];
      const resolved = aliasTarget?.model ?? requested;
      const calculation = calculateCandidates(ctx, state.configuration.allow);
      const selected = calculation.candidates.find(
        (candidate) => canonicalModel(candidate.model) === resolved,
      );
      if (!selected) {
        if (aliasTarget) {
          const available = new Set(
            calculation.availableModels.map((model) => canonicalModel(model)),
          );
          const native = new Set(
            calculation.nativeCandidates.map((candidate) =>
              canonicalModel(candidate.model),
            ),
          );
          const reason = !available.has(resolved)
            ? "is unavailable"
            : !native.has(resolved)
              ? "is outside Pi's native scope"
              : "is blocked by the allowlist";
          throw new Error(
            `Alias "${requested}" maps to "${resolved}", which ${reason}. Call model_switcher_list to see current models and aliases.`,
          );
        }
        if (!requested.includes("/")) {
          throw new Error(
            `Unknown model alias "${requested}". Call model_switcher_list to see configured aliases.`,
          );
        }
        throw new Error(
          `Model "${requested}" is not permitted. Call model_switcher_list to see available models and aliases.`,
        );
      }

      const aliasNote = aliasTarget ? ` via alias "${requested}"` : "";
      const requestedThinking = aliasTarget?.thinkingLevel;
      if (
        requestedThinking !== undefined &&
        !getSupportedThinkingLevels(selected.model).includes(requestedThinking)
      ) {
        throw new Error(
          `Alias "${requested}" requests thinking level "${requestedThinking}", but "${resolved}" does not support it.`,
        );
      }

      const current = ctx.model ? canonicalModel(ctx.model) : undefined;
      const currentThinking = pi.getThinkingLevel();
      if (
        current === resolved &&
        (requestedThinking === undefined ||
          currentThinking === requestedThinking)
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Already using ${resolved}${aliasNote}. Thinking: ${currentThinking}`,
            },
          ],
          details: {
            model: resolved,
            ...(aliasTarget ? { requested, alias: requested } : {}),
            thinking: currentThinking,
            ...(requestedThinking !== undefined
              ? { thinkingLevel: requestedThinking }
              : {}),
            noop: true,
          },
        };
      }

      if (current === resolved && requestedThinking !== undefined) {
        pi.setThinkingLevel(requestedThinking);
        const thinking = pi.getThinkingLevel();
        if (thinking !== requestedThinking) {
          throw new Error(
            `Could not apply alias "${requested}"; requested thinking level "${requestedThinking}" but Pi applied "${thinking}".`,
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Applied alias "${requested}" to ${resolved}. Thinking: ${thinking}`,
            },
          ],
          details: {
            model: resolved,
            requested,
            alias: requested,
            thinking,
            thinkingLevel: requestedThinking,
            noop: false,
          },
        };
      }

      let switched: boolean | undefined;
      try {
        switched = await pi.setModel(selected.model);
      } catch {
        throw new Error(
          `Could not switch to ${resolved}; the provider may not be authenticated.`,
        );
      }
      if (switched === false) {
        throw new Error(
          `Could not switch to ${resolved}; the provider may not be authenticated.`,
        );
      }
      if (requestedThinking !== undefined) {
        pi.setThinkingLevel(requestedThinking);
      } else if (selected.thinkingLevel !== undefined) {
        pi.setThinkingLevel(selected.thinkingLevel);
      }
      const thinking = pi.getThinkingLevel();
      if (requestedThinking !== undefined && thinking !== requestedThinking) {
        throw new Error(
          `Could not apply alias "${requested}"; requested thinking level "${requestedThinking}" but Pi applied "${thinking}".`,
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Switched to ${resolved}${aliasNote}. Thinking: ${thinking}`,
          },
        ],
        details: {
          model: resolved,
          ...(aliasTarget ? { requested, alias: requested } : {}),
          thinking,
          ...(requestedThinking !== undefined
            ? { thinkingLevel: requestedThinking }
            : {}),
          noop: false,
        },
      };
    },
  });

  pi.on("session_start", (event, ctx) => {
    restoreSessionState(pi, state, event.reason, ctx);
  });

  pi.registerCommand("model-switcher", {
    description: "Show or change model switching permission, or list aliases",
    getArgumentCompletions: (prefix) => modelSwitcherCompletions(prefix),
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command) {
        ctx.ui.notify(permissionStatus(pi, state, ctx), "info");
        return;
      }
      if (command === "aliases") {
        updateConfiguration(pi, state, ctx);
        ctx.ui.notify(
          formatConfiguredAliases(state.configuration.aliases),
          "info",
        );
        return;
      }
      if (command !== "allow" && command !== "deny") {
        ctx.ui.notify("Usage: /model-switcher [allow|deny|aliases]", "error");
        return;
      }

      updateConfiguration(pi, state, ctx);
      const allowed = command === "allow";
      setSessionOverride(pi, state, allowed);
      ctx.ui.notify(
        allowed
          ? "Agent-driven model switching allowed"
          : "Agent-driven model switching denied",
        "info",
      );
      if (allowed && !hasAllowedModels(ctx, state.configuration)) {
        ctx.ui.notify(
          "Current configuration allows no models for agent-driven model switching.",
          "warning",
        );
      }
      pi.sendMessage(
        {
          customType: PERMISSION_CHANGE_MESSAGE_TYPE,
          content: allowed ? ALLOWED_MESSAGE : DENIED_MESSAGE,
          display: false,
        },
        { triggerTurn: false },
      );
    },
  });
}
