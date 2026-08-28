import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  MODEL_SWITCHER_PERMISSION_GUIDANCE,
  calculateCandidates,
  findLatestPermissionEntry,
  formatPermissionStatus,
  modelSwitcherCompletions,
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
    });
    expect(
      resolvePermission(
        { allowed: undefined, allow: "all" },
        null,
        false,
        false,
      ),
    ).toEqual({
      allowed: false,
      source: "default",
    });
    expect(
      resolveConfiguration({ "model-switcher": { enabled: true } }, {}, true),
    ).toEqual({ allowed: undefined, allow: "all" });
  });

  it("merges trusted project fields and replaces arrays", () => {
    expect(
      resolveConfiguration(
        { "model-switcher": { allowed: true, allow: ["a/one", "a/two"] } },
        { "model-switcher": { allow: ["b/three"] } },
        true,
      ),
    ).toEqual({ allowed: true, allow: ["b/three"] });
    expect(
      resolveConfiguration(
        { "model-switcher": { allowed: true, allow: ["a/one"] } },
        { "model-switcher": { allow: "all" } },
        true,
      ),
    ).toEqual({ allowed: true, allow: "all" });
    expect(
      resolveConfiguration(
        { "model-switcher": { allowed: true } },
        { "model-switcher": { allowed: false } },
        false,
      ),
    ).toEqual({ allowed: true, allow: "all" });
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
    ).toEqual({ allowed: false, allow: ["a/one", "b/two/with/slashes"] });
    expect(warnings).toHaveLength(2);
    expect(normalizeAllowlist("invalid")).toEqual([]);
    expect(normalizeAllowlist(["provider/*"])).toEqual([]);
    expect(normalizeCanonicalIdentifier(" provider/model/id ")).toBe(
      "provider/model/id",
    );
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
    ).toEqual({ allowed: false, allow: [] });
    expect(invalidWarnings).toHaveLength(1);
    const missingAllowWarnings: string[] = [];
    expect(
      resolveConfiguration(
        { "model-switcher": { allowed: true } },
        {},
        true,
        missingAllowWarnings,
      ),
    ).toEqual({ allowed: true, allow: "all" });
    expect(missingAllowWarnings).toEqual([]);
  });

  it("applies session, deny-wins flags, config, and default precedence", () => {
    const config = { allowed: true, allow: "all" as const };
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
});

async function extensionHarness(
  options: {
    models?: readonly NonNullable<ExtensionContext["model"]>[];
    scopedModels?: readonly ExtensionContext["scopedModels"][number][];
    flags?: Record<string, boolean>;
    branch?: readonly unknown[];
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
  const setThinkingLevel = vi.fn();
  const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
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
    getThinkingLevel: vi.fn(() => "high"),
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
    expect(modelSwitcherCompletions("al")).toHaveLength(1);
    expect(modelSwitcherCompletions("x")).toBeNull();
  });

  it("does not accept legacy enable/disable command names", async () => {
    const harness = await extensionHarness();
    await harness.commands.get("model-switcher").handler("enable", harness.ctx);
    await harness.commands
      .get("model-switcher")
      .handler("disable", harness.ctx);
    expect(harness.ctx.ui.notify).toHaveBeenNthCalledWith(
      1,
      "Usage: /model-switcher [allow|deny]",
      "error",
    );
    expect(harness.ctx.ui.notify).toHaveBeenNthCalledWith(
      2,
      "Usage: /model-switcher [allow|deny]",
      "error",
    );
    expect(harness.appendEntry).not.toHaveBeenCalled();
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

  it("caps list output at 200 entries", async () => {
    const models = Array.from({ length: 205 }, (_, index) =>
      model("provider", `model-${String(index).padStart(3, "0")}`),
    );
    const harness = await extensionHarness({ models });
    await harness.commands.get("model-switcher").handler("allow", harness.ctx);
    const result = await harness.tools
      .get("model_switcher_list")
      .execute("id", {}, undefined, undefined, harness.ctx);
    expect(result.details.totalMatches).toBe(205);
    expect(result.details.returned).toHaveLength(200);
    expect(result.details.truncated).toBe(true);
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
