import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  MODEL_SWITCHER_PERMISSION_GUIDANCE,
  calculateAliases,
  calculateCandidates,
  findLatestPermissionEntry,
  formatPermissionStatus,
  modelSwitcherCompletions,
  normalizeAliases,
  normalizeAllowlist,
  normalizeCanonicalIdentifier,
  resolveConfiguration,
  resolvePermission,
} from "../src/index.js";

const model = (provider: string, id: string, name = id) =>
  ({ provider, id, name, reasoning: true }) as unknown as NonNullable<
    ExtensionContext["model"]
  >;

function context(
  models: readonly NonNullable<ExtensionContext["model"]>[],
  scopedModels: readonly ExtensionContext["scopedModels"][number][] = [],
) {
  return {
    modelRegistry: {
      getAvailable: () => [...models],
      refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    },
    scopedModels,
  } as unknown as Pick<ExtensionContext, "modelRegistry" | "scopedModels">;
}

describe("settings and permission policy", () => {
  it("defaults to denied and unrestricted", () => {
    expect(resolveConfiguration({}, {}, true)).toEqual({
      allowed: undefined,
      allow: "all",
      aliases: {},
    });
    expect(
      resolvePermission(
        { allowed: undefined, allow: "all", aliases: {} },
        null,
        false,
        false,
      ),
    ).toEqual({
      allowed: false,
      source: "default",
    });
  });

  it("merges trusted project fields and replaces arrays", () => {
    expect(
      resolveConfiguration(
        { "model-switcher": { allowed: true, allow: ["a/one", "a/two"] } },
        { "model-switcher": { allow: ["b/three"] } },
        true,
      ),
    ).toEqual({ allowed: true, allow: ["b/three"], aliases: {} });
    expect(
      resolveConfiguration(
        { "model-switcher": { allowed: true, allow: ["a/one"] } },
        { "model-switcher": { allow: "all" } },
        true,
      ),
    ).toEqual({ allowed: true, allow: "all", aliases: {} });
    expect(
      resolveConfiguration(
        { "model-switcher": { allowed: true } },
        { "model-switcher": { allowed: false } },
        false,
      ),
    ).toEqual({ allowed: true, allow: "all", aliases: {} });
  });

  it("fails closed for invalid values and warns once for mixed entries", () => {
    const warnings: string[] = [];
    expect(
      resolveConfiguration(
        {
          "model-switcher": {
            allowed: "yes",
            allow: [" a/one ", "", 42, "a/one", "b/two/with/slashes"],
          },
        },
        {},
        true,
        warnings,
      ),
    ).toEqual({
      allowed: false,
      allow: ["a/one", "b/two/with/slashes"],
      aliases: {},
    });
    expect(warnings).toHaveLength(2);
    expect(normalizeAllowlist("invalid")).toEqual([]);
    expect(normalizeAllowlist(["provider/*"])).toEqual([]);
    expect(normalizeCanonicalIdentifier(" provider/model/id ")).toBe(
      "provider/model/id",
    );
  });

  it("normalizes aliases and lets trusted project aliases replace global aliases", () => {
    const warnings: string[] = [];
    expect(
      resolveConfiguration(
        {
          "model-switcher": {
            aliases: {
              smart: { model: "global/model", thinkingLevel: "high" },
              worker: { model: "global/worker", thinkingLevel: "medium" },
            },
          },
        },
        {
          "model-switcher": {
            aliases: {
              " smart ": {
                model: "provider/model/id",
                thinkingLevel: "high",
              },
              BAD: { model: "provider/bad", thinkingLevel: "high" },
              worker: { model: "provider/worker", thinkingLevel: "medium" },
              invalid: { model: "not-canonical", thinkingLevel: "high" },
            },
          },
        },
        true,
        warnings,
      ),
    ).toEqual({
      allowed: undefined,
      allow: "all",
      aliases: {
        smart: { model: "provider/model/id", thinkingLevel: "high" },
        worker: { model: "provider/worker", thinkingLevel: "medium" },
      },
    });
    expect(warnings).toHaveLength(2);
    expect(normalizeAliases(undefined)).toEqual({});
    expect(
      normalizeAliases({
        "worker name": { model: "provider/model", thinkingLevel: "high" },
      }),
    ).toEqual({});
  });

  it("requires strict model-and-thinking alias presets without fallbacks", () => {
    const warnings: string[] = [];
    expect(
      normalizeAliases(
        {
          good: { model: "provider/model", thinkingLevel: "high" },
          stringForm: "provider/model",
          missingThinking: { model: "provider/model" },
          extra: {
            model: "provider/model",
            thinkingLevel: "high",
            note: "ignored",
          },
          badThinking: { model: "provider/model", thinkingLevel: "urgent" },
          badModel: { model: "provider/*", thinkingLevel: "high" },
        },
        warnings,
      ),
    ).toEqual({
      good: { model: "provider/model", thinkingLevel: "high" },
    });
    expect(warnings).toHaveLength(5);
  });

  it("ignores aliases from untrusted project settings", () => {
    expect(
      resolveConfiguration(
        {
          "model-switcher": {
            aliases: {
              smart: { model: "global/model", thinkingLevel: "high" },
            },
          },
        },
        {
          "model-switcher": {
            aliases: {
              worker: { model: "project/model", thinkingLevel: "high" },
            },
          },
        },
        false,
      ),
    ).toEqual({
      allowed: undefined,
      allow: "all",
      aliases: {
        smart: { model: "global/model", thinkingLevel: "high" },
      },
    });
  });

  it("rejects an invalid namespace and does not warn for missing allow", () => {
    const invalidWarnings: string[] = [];
    expect(
      resolveConfiguration(
        { "model-switcher": true },
        {},
        true,
        invalidWarnings,
      ),
    ).toEqual({ allowed: false, allow: [], aliases: {} });
    expect(invalidWarnings).toHaveLength(1);
    const missingAllowWarnings: string[] = [];
    expect(
      resolveConfiguration(
        { "model-switcher": { allowed: true } },
        {},
        true,
        missingAllowWarnings,
      ),
    ).toEqual({ allowed: true, allow: "all", aliases: {} });
    expect(missingAllowWarnings).toEqual([]);
  });

  it("applies session, deny-wins flags, config, and default precedence", () => {
    const config = { allowed: true, allow: "all" as const, aliases: {} };
    expect(resolvePermission(config, null, false, false)).toEqual({
      allowed: true,
      source: "config",
    });
    expect(resolvePermission(config, null, true, true)).toEqual({
      allowed: false,
      source: "flag",
    });
    expect(resolvePermission(config, true, false, true)).toEqual({
      allowed: true,
      source: "session",
    });
    expect(
      formatPermissionStatus({ allowed: false, source: "default" }, true),
    ).toBe("Agent-driven model switching: denied");
    expect(
      formatPermissionStatus({ allowed: true, source: "session" }, false),
    ).toContain("allowed models: none");
  });
});

describe("session entries and candidate calculation", () => {
  it("restores newest valid branch entry and ignores malformed entries", () => {
    expect(
      findLatestPermissionEntry([
        {
          type: "custom",
          customType: "pi-model-switcher:permission",
          data: { version: 1, override: "allowed" },
        },
        {
          type: "custom",
          customType: "other",
          data: { version: 1, override: "denied" },
        },
        {
          type: "custom",
          customType: "pi-model-switcher:permission",
          data: { version: 9, override: "denied" },
        },
        {
          type: "custom",
          customType: "pi-model-switcher:permission",
          data: { version: 1, override: "denied" },
        },
      ]),
    ).toEqual({ version: 1, override: "denied" });
  });

  it("uses native scope, reconciles current models, intersects exact allowlists, and sorts", () => {
    const one = model("z", "model/one");
    const two = model("a", "model/two", "Two");
    const unavailable = model("x", "gone");
    const result = calculateCandidates(
      context(
        [one, two],
        [
          { model: unavailable },
          { model: one, thinkingLevel: "high" },
          { model: two },
        ],
      ),
      ["z/model/one", "a/model/two"],
    );
    expect(
      result.nativeCandidates.map((entry) => entry.model.provider),
    ).toEqual(["z", "a"]);
    expect(
      result.candidates.map(
        (entry) => `${entry.model.provider}/${entry.model.id}`,
      ),
    ).toEqual(["a/model/two", "z/model/one"]);
    expect(result.candidates[1].thinkingLevel).toBe("high");

    const unrestricted = calculateCandidates(
      context([one], [{ model: two }]),
      "all",
    );
    expect(unrestricted.candidates.map((entry) => entry.model.id)).toEqual([]);
  });

  it("classifies aliases by availability, scope, and allowlist", () => {
    const one = model("a", "one");
    const two = model("b", "two");
    const aliases = {
      available: { model: "a/one", thinkingLevel: "high" as const },
      blocked: { model: "b/two", thinkingLevel: "high" as const },
      outside: { model: "b/two", thinkingLevel: "high" as const },
      missing: { model: "c/missing", thinkingLevel: "high" as const },
    };
    const scoped = calculateCandidates(context([one, two], [{ model: one }]), [
      "a/one",
    ]);
    expect(calculateAliases(aliases)).toEqual([
      { alias: "available", model: "a/one", thinkingLevel: "high" },
      { alias: "blocked", model: "b/two", thinkingLevel: "high" },
      { alias: "missing", model: "c/missing", thinkingLevel: "high" },
      { alias: "outside", model: "b/two", thinkingLevel: "high" },
    ]);
    const blocked = calculateCandidates(context([one, two]), ["a/one"]);
    expect(
      calculateAliases({ blocked: { model: "b/two", thinkingLevel: "high" } }),
    ).toEqual([{ alias: "blocked", model: "b/two", thinkingLevel: "high" }]);
  });
});

async function extensionHarness(
  options: {
    models?: readonly NonNullable<ExtensionContext["model"]>[];
    scopedModels?: readonly ExtensionContext["scopedModels"][number][];
    flags?: Record<string, boolean>;
    branch?: readonly unknown[];
    aliases?: Record<
      string,
      {
        model: string;
        thinkingLevel:
          | "off"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max";
      }
    >;
    applyThinking?: boolean;
    allow?: "all" | string[];
  } = {},
) {
  const models = options.models ?? [model("a", "one"), model("b", "two")];
  const scopedModels = options.scopedModels ?? [];
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const flagValues = new Map(Object.entries(options.flags ?? {}));
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const setModel = vi.fn(async () => true);
  let thinkingLevel = "high";
  const setThinkingLevel = vi.fn((level: string) => {
    if (options.applyThinking !== false) thinkingLevel = level;
  });
  const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
  vi.spyOn(SettingsManager, "create").mockReturnValue({
    drainErrors: () => [],
    getGlobalSettings: () => ({
      "model-switcher": {
        ...(options.allow !== undefined ? { allow: options.allow } : {}),
        ...(options.aliases !== undefined ? { aliases: options.aliases } : {}),
      },
    }),
    getProjectSettings: () => ({}),
  } as never);
  const fakePi = {
    registerFlag: (name: string) => {
      if (!flagValues.has(name)) flagValues.set(name, false);
    },
    getFlag: (name: string) => flagValues.get(name),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    appendEntry,
    sendMessage,
    setModel,
    getThinkingLevel: vi.fn(() => thinkingLevel),
    setThinkingLevel,
    on: (event: string, handler: any) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  const registry = {
    getAvailable: () => [...models],
    refresh,
  };
  const ctx = {
    ...context(models, scopedModels),
    modelRegistry: registry,
    cwd: "/tmp/pi-model-switcher-test",
    hasUI: true,
    isProjectTrusted: () => false,
    model: models[0],
    ui: { notify: vi.fn() },
    sessionManager: { getBranch: () => [...(options.branch ?? [])] },
  } as unknown as ExtensionContext;
  const { default: extension } = await import("../src/index.js");
  extension(fakePi);
  return {
    tools,
    commands,
    handlers,
    ctx,
    appendEntry,
    sendMessage,
    setModel,
    setThinkingLevel,
    refresh,
  };
}

describe("autocomplete and extension registration", () => {
  it("filters command completions and returns null for no matches", () => {
    expect(modelSwitcherCompletions("allo")).toHaveLength(1);
    expect(modelSwitcherCompletions("ali")).toHaveLength(1);
    expect(modelSwitcherCompletions("x")).toBeNull();
  });

  it("shows aliases from the user command without changing permission", async () => {
    const harness = await extensionHarness({
      aliases: {
        worker: { model: "b/two", thinkingLevel: "high" },
        smart: { model: "a/one", thinkingLevel: "medium" },
      },
    });
    await harness.commands
      .get("model-switcher")
      .handler("aliases", harness.ctx);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      "Model aliases:\n- smart → a/one · thinking: medium\n- worker → b/two · thinking: high",
      "info",
    );
    expect(harness.appendEntry).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it("registers three stable sequential tools and gates list", async () => {
    const harness = await extensionHarness({
      flags: { "model-switcher-deny": true },
    });
    expect([...harness.tools.keys()]).toEqual([
      "model_switcher_whoami",
      "model_switcher_list",
      "model_switcher",
    ]);
    expect(
      [...harness.tools.values()].every(
        (tool) => tool.executionMode === "sequential",
      ),
    ).toBe(true);
    await expect(
      harness.tools
        .get("model_switcher_list")
        .execute("id", {}, undefined, undefined, harness.ctx),
    ).rejects.toThrow(MODEL_SWITCHER_PERMISSION_GUIDANCE);
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it("reports live identity with the unauthorized nudge and no redundant name", async () => {
    const current = model("anthropic", "claude-sonnet-4-5");
    const harness = await extensionHarness({
      models: [current],
      flags: { "model-switcher-deny": true },
    });
    const result = await harness.tools
      .get("model_switcher_whoami")
      .execute("id", {}, undefined, undefined, harness.ctx);
    expect(result.content[0].text).toContain(
      "Current model: anthropic/claude-sonnet-4-5",
    );
    expect(result.content[0].text).toContain("Thinking: high");
    expect(result.content[0].text).toContain("not allowed");
    expect(result.details.switchingAllowed).toBe(false);
    expect(result.details.name).toBeUndefined();

    await harness.commands.get("model-switcher").handler("allow", harness.ctx);
    const allowed = await harness.tools
      .get("model_switcher_whoami")
      .execute("id", {}, undefined, undefined, harness.ctx);
    expect(allowed.content[0].text).not.toContain("not authorized");
  });

  it("lists queried models, falls back to cache, and distinguishes empty queries", async () => {
    const one = model("a", "one", "Alpha");
    const two = model("b", "two", "Beta");
    const harness = await extensionHarness({ models: [one, two] });
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);
    const result = await harness.tools
      .get("model_switcher_list")
      .execute("id", { query: "beta" }, undefined, undefined, harness.ctx);
    expect(result.details.returned).toEqual(["b/two"]);
    expect(result.content[0].text).toContain("b/two — Beta");

    harness.refresh.mockRejectedValueOnce(new Error("offline"));
    const fallback = await harness.tools
      .get("model_switcher_list")
      .execute("id", { query: "missing" }, undefined, undefined, harness.ctx);
    expect(fallback.details.refreshFallback).toBe(true);
    expect(fallback.details.noModelsReason).toBe("query");
    expect(fallback.content[0].text).toContain("No models match the query.");
    expect(fallback.content[0].text).toContain("showing cached models");
  });

  it("lists models and aliases together with deterministic presets and query matching", async () => {
    const one = model("a", "one", "Alpha");
    const two = model("b", "two", "Beta");
    const harness = await extensionHarness({
      models: [one, two],
      aliases: {
        worker: { model: "b/two", thinkingLevel: "high" },
        missing: { model: "c/missing", thinkingLevel: "medium" },
      },
    });
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);
    const result = await harness.tools
      .get("model_switcher_list")
      .execute("id", {}, undefined, undefined, harness.ctx);
    expect(result.details.aliases).toEqual({
      missing: { model: "c/missing", thinkingLevel: "medium" },
      worker: { model: "b/two", thinkingLevel: "high" },
    });
    expect(result.details.totalAliasMatches).toBe(2);
    expect(result.content[0].text).toContain("Aliases (2):");
    expect(result.content[0].text).toContain(
      "- worker → b/two · thinking: high",
    );

    const queried = await harness.tools
      .get("model_switcher_list")
      .execute("id", { query: "worker" }, undefined, undefined, harness.ctx);
    expect(queried.details.returned).toEqual(["b/two"]);
    expect(queried.details.totalAliasMatches).toBe(1);
    expect(queried.content[0].text).toContain("Aliases (1):");

    const thinkingQueried = await harness.tools
      .get("model_switcher_list")
      .execute("id", { query: "medium" }, undefined, undefined, harness.ctx);
    expect(thinkingQueried.details.totalAliasMatches).toBe(1);
    expect(thinkingQueried.details.aliases).toEqual({
      missing: { model: "c/missing", thinkingLevel: "medium" },
    });
  });

  it("caps models and aliases independently at 200 entries", async () => {
    const models = Array.from({ length: 205 }, (_, index) =>
      model("provider", `model-${String(index).padStart(3, "0")}`),
    );
    const aliases = Object.fromEntries(
      Array.from({ length: 205 }, (_, index) => [
        `alias-${String(index).padStart(3, "0")}`,
        {
          model: `provider/model-${String(index).padStart(3, "0")}`,
          thinkingLevel: "high" as const,
        },
      ]),
    );
    const harness = await extensionHarness({ models, aliases });
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);
    const result = await harness.tools
      .get("model_switcher_list")
      .execute("id", {}, undefined, undefined, harness.ctx);
    expect(result.details.totalMatches).toBe(205);
    expect(result.details.returned).toHaveLength(200);
    expect(result.details.truncated).toBe(true);
    expect(result.details.totalAliasMatches).toBe(205);
    expect(Object.keys(result.details.aliases)).toHaveLength(200);
    expect(result.details.aliasesTruncated).toBe(true);
    expect(result.content[0].text).toContain("narrower query");
  });

  it("switches exact scoped models, applies pinned thinking, and supports no-op", async () => {
    const one = model("a", "one");
    const two = model("b", "two");
    const harness = await extensionHarness({
      models: [one, two],
      scopedModels: [{ model: two, thinkingLevel: "low" }],
    });
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);
    const switched = await harness.tools
      .get("model_switcher")
      .execute("id", { model: " b/two " }, undefined, undefined, harness.ctx);
    expect(switched.content[0].text).toContain("Switched to b/two");
    expect(harness.setModel).toHaveBeenCalledWith(two);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith("low");

    (harness.ctx as { model: unknown }).model = two;
    harness.setModel.mockClear();
    const noop = await harness.tools
      .get("model_switcher")
      .execute("id", { model: "b/two" }, undefined, undefined, harness.ctx);
    expect(noop.details.noop).toBe(true);
    expect(harness.setModel).not.toHaveBeenCalled();
  });

  it("switches through aliases, reports no-ops, and enforces model policy", async () => {
    const one = model("a", "one");
    const two = model("b", "two");
    const harness = await extensionHarness({
      models: [one, two],
      scopedModels: [{ model: one }, { model: two, thinkingLevel: "low" }],
      aliases: {
        smart: { model: "b/two", thinkingLevel: "high" },
        blocked: { model: "a/one", thinkingLevel: "medium" },
      },
      allow: ["b/two"],
    });
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);

    const switched = await harness.tools
      .get("model_switcher")
      .execute("id", { model: "smart" }, undefined, undefined, harness.ctx);
    expect(switched.content[0].text).toContain(
      'Switched to b/two via alias "smart"',
    );
    expect(switched.details).toMatchObject({
      model: "b/two",
      requested: "smart",
      alias: "smart",
      noop: false,
    });
    expect(harness.setModel).toHaveBeenCalledWith(two);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");

    (harness.ctx as { model: unknown }).model = two;
    harness.setModel.mockClear();
    const noop = await harness.tools
      .get("model_switcher")
      .execute("id", { model: "smart" }, undefined, undefined, harness.ctx);
    expect(noop.content[0].text).toContain(
      'Already using b/two via alias "smart"',
    );
    expect(noop.details.noop).toBe(true);
    expect(harness.setModel).not.toHaveBeenCalled();

    await expect(
      harness.tools
        .get("model_switcher")
        .execute("id", { model: "blocked" }, undefined, undefined, harness.ctx),
    ).rejects.toThrow('Alias "blocked" maps to "a/one"');
    expect(harness.setModel).not.toHaveBeenCalled();
  });

  it("changes thinking for same-model aliases and rejects unsupported presets before mutation", async () => {
    const one = model("a", "one");
    const harness = await extensionHarness({
      models: [one],
      aliases: {
        deep: { model: "a/one", thinkingLevel: "low" },
        unsupported: { model: "a/one", thinkingLevel: "xhigh" },
      },
    });
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);

    const changed = await harness.tools
      .get("model_switcher")
      .execute("id", { model: "deep" }, undefined, undefined, harness.ctx);
    expect(changed.content[0].text).toContain(
      'Applied alias "deep" to a/one. Thinking: low',
    );
    expect(changed.details).toMatchObject({
      model: "a/one",
      alias: "deep",
      thinkingLevel: "low",
      thinking: "low",
      noop: false,
    });
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.setThinkingLevel).toHaveBeenCalledWith("low");

    harness.setThinkingLevel.mockClear();
    await expect(
      harness.tools
        .get("model_switcher")
        .execute(
          "id",
          { model: "unsupported" },
          undefined,
          undefined,
          harness.ctx,
        ),
    ).rejects.toThrow("does not support it");
    expect(harness.setModel).not.toHaveBeenCalled();
    expect(harness.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("reports graceful alias and provider failures without false success", async () => {
    const one = model("a", "one");
    const two = model("b", "two");
    const unavailable = await extensionHarness({
      models: [one, two],
      aliases: { missing: { model: "c/missing", thinkingLevel: "high" } },
    });
    await unavailable.commands
      .get("model-switcher")
      .handler("allow", unavailable.ctx);
    await expect(
      unavailable.tools
        .get("model_switcher")
        .execute(
          "id",
          { model: "missing" },
          undefined,
          undefined,
          unavailable.ctx,
        ),
    ).rejects.toThrow("which is unavailable");
    expect(unavailable.setModel).not.toHaveBeenCalled();

    const outside = await extensionHarness({
      models: [one, two],
      scopedModels: [{ model: one }],
      aliases: { outside: { model: "b/two", thinkingLevel: "high" } },
    });
    await outside.commands.get("model-switcher").handler("allow", outside.ctx);
    await expect(
      outside.tools
        .get("model_switcher")
        .execute("id", { model: "outside" }, undefined, undefined, outside.ctx),
    ).rejects.toThrow("outside Pi's native scope");
    expect(outside.setModel).not.toHaveBeenCalled();

    const unknown = await extensionHarness({ models: [one] });
    await unknown.commands.get("model-switcher").handler("allow", unknown.ctx);
    await expect(
      unknown.tools
        .get("model_switcher")
        .execute("id", { model: "mystery" }, undefined, undefined, unknown.ctx),
    ).rejects.toThrow('Unknown model alias "mystery"');

    const providerFailure = await extensionHarness({ models: [one, two] });
    await providerFailure.commands
      .get("model-switcher")
      .handler("allow", providerFailure.ctx);
    providerFailure.setModel.mockRejectedValueOnce(new Error("auth"));
    await expect(
      providerFailure.tools
        .get("model_switcher")
        .execute(
          "id",
          { model: "b/two" },
          undefined,
          undefined,
          providerFailure.ctx,
        ),
    ).rejects.toThrow("Could not switch");
  });

  it("rejects unexpected effective thinking levels after alias application", async () => {
    const one = model("a", "one");
    const two = model("b", "two");
    const harness = await extensionHarness({
      models: [one, two],
      applyThinking: false,
      aliases: { deep: { model: "b/two", thinkingLevel: "low" } },
    });
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);
    await expect(
      harness.tools
        .get("model_switcher")
        .execute("id", { model: "deep" }, undefined, undefined, harness.ctx),
    ).rejects.toThrow("Could not apply alias");
    expect(harness.setModel).toHaveBeenCalledWith(two);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith("low");
  });

  it("rejects disallowed targets and does not claim false native switches", async () => {
    const one = model("a", "one");
    const two = model("b", "two");
    const harness = await extensionHarness({ models: [one, two] });
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);
    const originalRefresh = harness.refresh;
    await expect(
      harness.tools
        .get("model_switcher")
        .execute(
          "id",
          { model: "b/missing" },
          undefined,
          undefined,
          harness.ctx,
        ),
    ).rejects.toThrow("model_switcher_list");
    expect(originalRefresh).not.toHaveBeenCalled();
    harness.setModel.mockResolvedValueOnce(false);
    await expect(
      harness.tools
        .get("model_switcher")
        .execute("id", { model: "b/two" }, undefined, undefined, harness.ctx),
    ).rejects.toThrow("Could not switch");
  });

  it("persists command toggles and resets new/fork lifecycle state", async () => {
    const inherited = {
      type: "custom",
      customType: "pi-model-switcher:permission",
      data: { version: 1, override: "allowed" },
    };
    const harness = await extensionHarness({
      branch: [inherited],
      flags: { "model-switcher-deny": true },
    });
    await harness.handlers.get("session_start")(
      { reason: "startup" },
      harness.ctx,
    );
    await harness.commands.get("model-switcher").handler("", harness.ctx);
    expect(
      harness.ctx.ui.notify as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith(expect.stringContaining("source: session"), "info");
    await harness.handlers.get("session_start")({ reason: "new" }, harness.ctx);
    await harness.commands.get("model-switcher").handler("", harness.ctx);
    expect(
      harness.ctx.ui.notify as ReturnType<typeof vi.fn>,
    ).toHaveBeenLastCalledWith(
      "Agent-driven model switching: denied · source: flag",
      "info",
    );

    await harness.handlers.get("session_start")(
      { reason: "fork" },
      harness.ctx,
    );
    expect(harness.appendEntry).toHaveBeenCalledWith(
      "pi-model-switcher:permission",
      { version: 1, override: "reset" },
    );
  });

  it("uses exact notification levels and hidden permission messages", async () => {
    const harness = await extensionHarness();
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);
    await harness.commands.get("model-switcher").handler("deny", harness.ctx);
    const notify = harness.ctx.ui.notify as ReturnType<typeof vi.fn>;
    expect(notify).toHaveBeenCalledWith(
      "Agent-driven model switching allowed",
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      "Agent-driven model switching denied",
      "info",
    );
    expect(harness.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "pi-model-switcher:permission-change",
        display: false,
      }),
      { triggerTurn: false },
    );
  });
});
