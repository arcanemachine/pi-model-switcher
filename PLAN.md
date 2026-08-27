# pi-model-switcher implementation plan

## Status and authority

This is the executable implementation plan for the first version of `pi-model-switcher`. It preserves the user-approved product and architecture decisions described below.

The plan itself does not authorize implementation. Begin execution only after the user assigns an implementation owner or explicitly asks an agent to execute this plan. Do not publish or push as part of this work.

The repository at `packages/pi-model-switcher` currently exists as an otherwise-empty Git repository on branch `main`, with this remote:

```text
git@github.com:arcanemachine/pi-model-switcher.git
```

The implementation owner must create the package contents. The superproject must ultimately track the child repository as the `packages/pi-model-switcher` Git submodule. Preserve the superproject/child-repository boundary and follow child-first commit order.

## Objective

Create a small Pi extension that lets an agent list and select models only when the user has authorized agent-driven model switching for the current session.

The extension must:

- register two always-active agent tools, `model_switcher_list` and `model_switcher`;
- keep both tool definitions stable across permission changes so enabling or disabling the capability does not alter the active tool set or invalidate the prompt cache for that reason;
- enforce one shared runtime permission gate before either tool can list or switch models;
- use Pi-native model scope, model registry, model refresh, model switching, thinking-level handling, events, session entries, extension flags, and UI primitives wherever they provide the required behavior;
- default to disabled when no setting, flag, or session override enables it;
- support global and trusted-project configuration, CLI overrides for newly created sessions, and persistent current-session overrides through `/model-switcher`;
- optionally narrow the Pi-native model scope through an exact model allowlist;
- keep tool descriptions, tool output, command output, and agent guidance concise;
- remain a private, unreleased package for now.

## User-approved behavior and terminology

### Tool and command names

- Agent-facing list tool: `model_switcher_list`
- Agent-facing switching tool: `model_switcher`
- User-facing slash command: `/model-switcher`
- CLI flags:
  - `--model-switcher-allow`
  - `--model-switcher-deny`
- Settings key: `model-switcher`

Use “agent-driven model switching” in user-facing permission status and notifications.

### Default posture

Agent-driven model switching is opt-in and disabled by default.

A missing setting, absent CLI flags, and no persisted session override must resolve to disabled. Merely loading the extension must never grant the agent model-switching permission.

### Configuration shape

Support this object in both Pi settings files:

```json
{
  "model-switcher": {
    "enabled": true,
    "allow": ["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"]
  }
}
```

Also support an explicit unrestricted value:

```json
{
  "model-switcher": {
    "enabled": true,
    "allow": "all"
  }
}
```

The effective schema is:

```typescript
interface ModelSwitcherSettings {
  enabled?: boolean;
  allow?: "all" | string[];
}
```

Do not support the earlier scalar boolean idea. This package has not been released, so no compatibility parser is needed for a boolean `"model-switcher"` value.

Configuration meanings:

- `enabled` omitted: disabled unless a higher-precedence source enables the current session.
- `allow` omitted everywhere: behave as `"all"`.
- `allow: "all"`: impose no extension-specific restriction beyond Pi’s current native session scope.
- `allow: ["provider/model", ...]`: only matching exact canonical model identifiers remain selectable after applying Pi’s native scope.
- `allow: []`: intentionally permit no target models.

“all” never bypasses Pi-native model scoping. It means all models within the current Pi session’s candidate set.

### Pi-native scope is always authoritative

Derive the base candidate set as follows:

1. If `ctx.scopedModels` is non-empty, use those entries as the base set.
2. Otherwise, use `ctx.modelRegistry.getAvailable()` as the base set.
3. If the extension’s effective `allow` value is an array, intersect the base set with that exact allowlist.
4. If effective `allow` is `"all"`, leave the base set unchanged.

Consequences:

- `enabledModels` and `--models` continue to control Pi’s native session scope.
- The extension cannot select a model outside that scope.
- The extension allowlist can narrow the native scope but cannot widen it.
- No separate `"scoped"` allow value is needed because native scope is always enforced.

Use canonical identifiers formed as `${model.provider}/${model.id}`. Model IDs may themselves contain `/` (for example routed provider model IDs), so never parse a canonical identifier by assuming only one slash. When validation requires separating provider from model ID, split at the first slash and preserve the remainder as the model ID.

Allowlist entries are exact identifiers, not globs and not fuzzy matches. Trim surrounding whitespace, reject empty values, deduplicate valid entries, and preserve deterministic behavior.

### Global/project settings merge and trust

Use Pi’s exported `SettingsManager`, `getAgentDir()`, `CONFIG_DIR_NAME` behavior embodied by `SettingsManager`, and `ctx.isProjectTrusted()` rather than implementing a general-purpose settings loader.

Create a settings manager for the current `ctx.cwd` with the current project-trust decision. Read the global and project settings snapshots, then resolve only the custom `model-switcher` namespace. The public settings type does not declare extension-owned keys, so use a narrow, documented type guard/cast at that boundary; do not access private `SettingsManager` fields.

Match Pi’s nested merge semantics for this namespace:

- trusted project fields override corresponding global fields;
- an omitted project field inherits the global field;
- arrays replace rather than concatenate;
- `allow: "all"` lets a trusted project explicitly remove an inherited global array restriction;
- untrusted project settings are ignored entirely.

If a project defines the entire `model-switcher` key with an invalid non-object value, treat the effective namespace as invalid rather than silently inheriting a permissive global configuration.

Configuration failure policy is deliberately fail-safe:

- invalid `enabled`: warn and resolve permission to disabled;
- invalid `allow` type: warn and resolve the allow policy to an empty set;
- invalid array entries: ignore those entries, retain valid entries, and issue one concise warning;
- missing `allow`: do not warn; it intentionally means all models in Pi’s current native scope;
- well-formed allowlist identifiers that do not currently resolve to available models are not schema errors; they simply produce no candidate until available.

Do not expose file contents or unrelated settings in warnings.

### Permission-source precedence

Resolve the current enabled/disabled state from highest to lowest precedence:

1. Explicit current-session override created by `/model-switcher enable` or `/model-switcher disable`
2. CLI flag override
3. Effective settings value
4. Disabled default

CLI conflict policy: if both `--model-switcher-allow` and `--model-switcher-deny` are present, deny wins.

The slash command must be able to override either CLI flag for the current session. The flags establish a new session’s initial state; they are not an irrevocable policy.

Track the source as one of:

```typescript
type PermissionSource = "default" | "config" | "flag" | "session";
```

“Source” means the highest-precedence source that determined the current enabled value. Do not distinguish global from project configuration in the concise command status.

### Session lifecycle and persistence

Persist only the explicit session permission override in a versioned custom session entry. Do not copy the model allowlist into session history; the allow policy must always be re-read from current trusted settings so tightening configuration also tightens a resumed authorized session.

Use a namespaced custom entry type such as:

```text
pi-model-switcher:permission
```

Store a compact, validated shape that supports enabled, disabled, and reset states. Include a schema version. Scan `ctx.sessionManager.getBranch()` newest-first so tree navigation and branches restore the state of the active branch rather than an unrelated entry elsewhere in the session file.

Lifecycle behavior:

- `startup`:
  - read current configuration and flags;
  - if the loaded session branch contains a valid explicit permission entry, restore it;
  - otherwise use the new-session baseline.
- `resume`:
  - re-read current configuration and flags;
  - restore the loaded session branch’s explicit permission override when present;
  - otherwise use the new-session baseline.
- `reload`:
  - re-read current configuration and flags;
  - restore the active branch’s explicit permission override;
  - do not emit toggle notifications merely because the extension reloaded.
- `new`:
  - clear inherited/in-memory session override state;
  - initialize from flags, then config, then disabled default.
- `fork`:
  - treat the fork as a new session for permission purposes;
  - initialize from flags, then config, then disabled default;
  - if the forked branch inherited a permission entry, append an explicit reset entry so a subsequent reload cannot resurrect the parent session’s authorization.

Do not emit hidden agent permission messages or user notifications during ordinary startup, resume, reload, new-session initialization, or fork initialization. Toggle messages are user-command feedback only.

### User-facing `/model-switcher` command

Register `/model-switcher` with these accepted forms:

```text
/model-switcher
/model-switcher enable
/model-switcher disable
```

No arguments:

- report the current permission status in one concise line;
- omit a source label for the disabled default;
- show `source: config`, `source: flag`, or `source: session` when one of those determined the state;
- do not dump configuration or model lists;
- if switching is enabled but the effective allowed candidate set is empty, append a short indication such as `allowed models: none`.

Examples:

```text
Agent-driven model switching: disabled
Agent-driven model switching: enabled · source: config
Agent-driven model switching: disabled · source: flag
Agent-driven model switching: enabled · source: session
Agent-driven model switching: enabled · source: session · allowed models: none
```

`enable` and `disable`:

- update the in-memory session override immediately;
- append the versioned custom permission entry immediately;
- show an explicit `info` notification through `ctx.ui.notify()`:
  - `Agent-driven model switching enabled`
  - `Agent-driven model switching disabled`
- use `info`, not `warning` or `error`, because these are intentional state changes;
- if enabling produces an empty effective candidate set, follow with one concise warning that current configuration allows no models;
- send a hidden custom message to the agent so a model already participating in the session knows permission changed;
- do not trigger an otherwise-idle agent response solely for the notification;
- when invoked during streaming, use the normal Pi custom-message delivery behavior so the changed permission is conveyed safely to the running agent.

Suggested hidden agent messages:

```text
Agent-driven model switching is now enabled for this session. You may use model_switcher_list and model_switcher when appropriate.
```

```text
Agent-driven model switching is now disabled for this session. Do not use model_switcher_list or model_switcher unless the user enables it again.
```

Use a namespaced custom message type such as `pi-model-switcher:permission-change` and `display: false`.

Autocomplete:

- `enable` — `Allow the agent to list and switch models in this session`
- `disable` — `Prevent the agent from listing or switching models in this session`

Filter completions by the typed prefix. Return `null` when no items match.

For unknown arguments, issue a concise error notification with the valid usage. Do not silently treat an unknown argument as status.

### Stable tools and prompt-cache boundary

Register both tools exactly once during extension initialization and leave both active for the entire extension runtime. Never call `pi.setActiveTools()` to implement permission changes.

Do not add `promptSnippet` or `promptGuidelines`. They would add unnecessary system-prompt content and are not needed for this capability. Keep the required permission note in each tool’s ordinary description, which is already part of its stable schema.

Suggested concise descriptions:

- `model_switcher_list`: `List models available to model_switcher. Requires user authorization for agent-driven model switching.`
- `model_switcher`: `Switch this session to an available provider/model. Requires user authorization for agent-driven model switching.`

Both tools must use the same permission-check helper before any model discovery, refresh, query evaluation, validation, or mutation. When disabled, throw an error so Pi marks the tool result as an error and the agent cannot mistake the operation for success.

Use this concise refusal guidance, or wording with the same meaning and no additional policy:

```text
Agent-driven model switching is disabled for this session. Only the user can enable it with /model-switcher enable. If the user asked you to switch models, ask them to enable it; otherwise do not retry either model-switcher tool.
```

The detailed corrective guidance must appear only in the failed tool result, not in permanent prompt guidelines.

Mark both tools `executionMode: "sequential"` so catalog refresh and model mutation cannot race other calls to these tools in the same tool batch.

### `model_switcher_list` contract

Schema:

```typescript
{
  query?: string;
}
```

Behavior after permission succeeds:

1. Attempt Pi’s native `ctx.modelRegistry.refresh()` with the current tool abort signal and a bounded timeout matching the built-in model-selector precedent (15 seconds is appropriate).
2. Always clear the timeout/controller resources.
3. If refresh fails or times out, fall back to the current cached registry snapshot and include one short note in the tool result; do not fail the whole list operation if cached models remain usable.
4. Reconcile `ctx.scopedModels` by canonical provider/model key against refreshed available model objects so the returned objects are current without widening scope.
5. Apply the effective extension allow policy.
6. Apply the optional case-insensitive query against canonical identifier and model display name.
7. Sort deterministically by provider and model ID. Present the current model clearly without creating a verbose table.

Keep output compact. A suitable shape is:

```text
Current: anthropic/claude-sonnet-4-5
Available models (2):
- anthropic/claude-sonnet-4-5 — Claude Sonnet 4.5
- openai/gpt-5.4 — GPT-5.4
```

Avoid repeating a display name when it is identical to the model ID. If the current model is outside the effective target set, still show it in the `Current:` line but do not add it to available targets.

Large catalogs must not consume unbounded model context. Return at most 200 matching entries and use Pi’s truncation utilities or an equivalently deterministic bounded formatter. If more entries match, state the total and tell the agent to call `model_switcher_list` again with a narrower `query`. Do not write a temporary catalog file.

When no models match, distinguish concisely among:

- no models permitted by current native scope/allow policy;
- no models matching the query;
- no currently available/authenticated models.

Return structured `details` useful for tests and renderers without duplicating excessive text, for example the current identifier, returned identifiers, total match count, whether truncated, and whether refresh fell back to cache.

### `model_switcher` contract

Schema:

```typescript
{
  model: string;
}
```

The parameter description must require the exact canonical identifier returned by `model_switcher_list`.

Behavior after permission succeeds:

1. Normalize surrounding whitespace only; do not fuzzy-match, accept aliases, or guess providers.
2. Build the same effective candidate set used by `model_switcher_list` from current available models, native scope, and extension allow policy.
3. Find an exact canonical identifier match.
4. If there is no match, throw a concise error telling the agent to call `model_switcher_list` to see permitted models.
5. If the requested model is already current, return a successful no-op result and do not append another model change or rewrite thinking state.
6. Otherwise call Pi-native `pi.setModel(model)`.
7. If Pi returns `false` or rejects because authentication is unavailable, report a concise failed tool result; never claim that the model switched.
8. If the selected entry came from `ctx.scopedModels` with an explicit pinned `thinkingLevel`, call `pi.setThinkingLevel(scoped.thinkingLevel)` after the successful `pi.setModel()` call. This reproduces scoped cycling’s explicit thinking-level override. For entries without a pinned level, rely on `pi.setModel()` to apply Pi’s native per-model/global/default thinking behavior.
9. Return the selected canonical identifier and effective thinking level concisely.

Do not persist the selected model as Pi’s global default. `pi.setModel()` through the extension API is session-scoped and already records the native session model-change entry and emits the native model-selection event.

Do not add a second custom model-change transcript entry or a duplicate user notification. Use Pi’s native event/UI behavior and the ordinary tool result.

## Package structure

Create a focused single-entrypoint package. Do not introduce abstractions beyond what the behavior and tests require.

Expected child files:

```text
packages/pi-model-switcher/
├── .gitignore
├── AGENTS.md
├── LICENSE.md
├── PLAN.md
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
└── tests/
    └── index.test.ts
```

A second small source module is permitted only if settings/state logic makes `src/index.ts` materially harder to understand or test. Do not create a framework of generic configuration classes.

Do not commit `node_modules`, `dist`, packed archives, temporary files, runtime settings, or test session data.

### Package metadata

Use:

```json
{
  "name": "@arcanemachine/pi-model-switcher",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

`private: true` is an npm publication guard. It must not interfere with local workspace use, local install, Git install, `npm pack --dry-run`, or Pi loading the package. Do not run `npm publish`, do not add release tags, and do not push.

The `pi` manifest must load `./src/index.ts`.

Use a concise description such as:

```text
User-authorized agent model switching for Pi sessions
```

Use the established author, MIT license, repository, homepage, bugs, engine, keyword, and optional-peer-dependency conventions from sibling `@arcanemachine` Pi packages where applicable. Point repository metadata at `https://github.com/arcanemachine/pi-model-switcher`.

Declare runtime dependencies in the child package rather than relying on transitive workspace availability:

- `typebox` at the version compatible with the project’s Pi dependency (`1.3.7` for Pi 0.84.x)

Declare development dependencies needed for an independently testable TypeScript package:

- `@earendil-works/pi-coding-agent` matching the superproject’s standing version (`0.84.1` at planning time)
- `@earendil-works/pi-tui` matching Pi when needed for the autocomplete type
- `@types/node`
- `prettier`
- `typescript`
- `vitest`

Declare Pi coding-agent and TUI peer dependencies as optional, following sibling package conventions. Do not add a runtime dependency that active scope does not need.

Provide package-local scripts for:

- `build`
- `typecheck`
- `test`
- `format`
- `format:check`

Use strict TypeScript with NodeNext module/module-resolution settings and an output directory excluded from source control.

### Child `AGENTS.md`

Create package-specific guidance that at minimum requires:

- commit completed coherent work in the child repository;
- Conventional Commit messages;
- package-local typecheck, test, build, and formatting checks;
- verification of user-facing changes against a running Pi session;
- no push or publish without explicit authorization;
- no npm release while `private: true` and version `0.0.0` remain;
- child commit before the superproject submodule-pointer/integration commit.

Keep it concise and evergreen.

### README requirements

Document:

- what the extension does;
- the opt-in security/cost posture;
- the two agent tools and their authorization boundary;
- `/model-switcher`, including no-argument status and enable/disable forms;
- both CLI flags and deny-wins conflict behavior;
- global and trusted-project settings paths;
- full settings examples for `allow: "all"`, an exact array, and an empty array;
- the fact that omitted `allow` means all models within Pi’s current native scope;
- interaction with Pi `enabledModels` and `--models` scoping;
- precedence: session command, flag, config, disabled default;
- resume/reload persistence and new/fork reset behavior;
- exact canonical `provider/model` identifiers;
- invalid configuration’s fail-safe behavior;
- local/Git installation and superproject usage;
- current unreleased/private status;
- concise examples without suggesting that an agent can authorize itself.

Do not document npm installation or publishing as an available release path yet.

## Superproject integration

After the child implementation is verified and committed, integrate it into `/workspace/projects/pi` without flattening the nested repository.

Required superproject changes:

1. Register `packages/pi-model-switcher` in `.gitmodules` with:

   ```text
   git@github.com:arcanemachine/pi-model-switcher.git
   ```

2. Ensure Git tracks the child as a gitlink/submodule, not ordinary files.
3. Add this extension path to root `package.json` → `pi.extensions`:

   ```text
   ./packages/pi-model-switcher/src/index.ts
   ```

4. Add the package to the root `README.md` package list. Classify it as unstable/unreleased rather than public-release-ready, with a concise description of user-authorized agent model switching.
5. Update `pnpm-lock.yaml` through the root workspace package manager after the child manifest exists.

Because the child directory already exists as a Git repository, do not delete or reclone it merely to run `git submodule add`. Use a safe Git-native registration flow. If Git cannot register the existing child repository as a submodule without destructive replacement, stop and ask the user rather than improvising or losing repository metadata.

The root formatter rewrites sibling packages. Never run `pnpm run format` at the superproject root for this task. Run formatting only within `pi-model-switcher` or against its explicit paths.

## Required reading for the implementation owner

Before editing, read:

- `/workspace/AGENTS.md`
- `AGENTS.md` at the `/workspace/projects/pi` superproject root
- this `packages/pi-model-switcher/PLAN.md`

Use these Pi documentation and source anchors for exact current APIs; do not substitute assumptions from older Pi versions:

- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
  - custom tools, error signaling, flags, commands, session events, custom entries/messages, `ctx.scopedModels`, and `pi.setModel()`
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`
  - global/project precedence and trust
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`
  - configured/available model semantics
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`
  - branch-aware custom state and native model/thinking entries
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.d.ts`
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
  - native set-model and scoped-thinking behavior
- `/usr/local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/model-selector.js`
  - available-model refresh and bounded refresh precedent

Relevant sibling patterns, to consult narrowly rather than copy wholesale:

- `packages/pi-role/src/index.ts` — command autocomplete, branch state restoration, hidden agent messages
- `packages/pi-notify-marker/src/index.ts` — fork reset entries
- `packages/pi-subagent/src/index.ts` — trusted global/project extension settings

Follow the installed docs matching the actual project dependency. If the project upgrades Pi before execution, revalidate the API anchors and adapt the plan mechanically; stop for user input if an upgrade changes product semantics or requires a new dependency/architecture decision.

## Testing strategy

Keep pure policy/state/formatting helpers exportable or otherwise directly testable. Use a small fake `ExtensionAPI`/context harness to capture registered tools, commands, flags, and session handlers rather than launching Pi for every unit test.

At minimum, cover these deterministic cases.

### Settings and allow policy

- no config resolves to disabled, source `default`, allow `all`;
- valid global object;
- trusted project field-by-field override/inheritance;
- untrusted project ignored;
- project `allow: "all"` clears an inherited global array;
- project array replaces rather than concatenates global array;
- missing allow produces no warning;
- invalid top-level namespace fails closed;
- invalid enabled becomes disabled with warning;
- invalid allow type becomes empty with warning;
- mixed valid/invalid entries retain valid entries and warn once;
- empty array permits no target models;
- duplicates and whitespace normalize deterministically;
- canonical IDs with slashes inside the model ID remain valid.

### Precedence and lifecycle

- session override beats flags and config;
- deny flag beats allow flag when both are true;
- either flag beats config;
- explicit config false reports source config;
- default disabled omits source in formatted status;
- startup/resume/reload restores the newest valid permission entry on the active branch;
- unrelated entries and malformed/unknown-version entries are ignored;
- `/new` resets to baseline;
- fork resets to baseline and writes a reset entry when inherited state exists;
- allow policy is re-read rather than restored from the session entry.

### Candidate calculation

- non-empty `ctx.scopedModels` is the base set;
- an empty scoped list uses available models;
- unavailable scoped entries are removed after registry reconciliation;
- `allow: "all"` never widens the native scope;
- exact array allowlist intersects native scope;
- current model can be reported even if outside selectable candidates;
- deterministic sorting;
- case-insensitive query matches canonical ID and display name;
- query does not change authorization or target validation;
- output caps at 200 models and tells the agent to narrow the query;
- refresh success uses current registry data;
- refresh timeout/failure falls back to cached data and reports that concisely;
- abort/timeout resources are cleaned up.

### Tool authorization and switching

- both tool definitions remain registered regardless of enabled state;
- neither tool calls `pi.setActiveTools()`;
- both tools reject before list discovery or model validation when disabled;
- both use the same approved refusal guidance;
- list discloses no model inventory while disabled;
- unavailable or disallowed exact target fails with list-tool guidance;
- current-model selection is a no-op;
- successful selection calls `pi.setModel()` once;
- a false/failed native set does not report success;
- a scoped pinned thinking level is applied after model selection;
- an unpinned entry relies on native model thinking behavior;
- tools are sequential;
- descriptions remain concise and include the authorization requirement;
- no prompt snippet or prompt guideline is registered.

### Command behavior

- no-argument status formatting for default/config/flag/session sources;
- status identifies an enabled state with zero allowed models without dumping configuration;
- enable/disable completions and descriptions;
- unknown argument error;
- enable/disable persist state immediately;
- exact `info` user notification text;
- concise warning when enabling with no allowed models;
- hidden agent message contents and `display: false`;
- command toggle can override a CLI-derived baseline for the current session.

## Verification and acceptance

A change is not verified merely because unit tests pass.

### Child-package checks

From `packages/pi-model-switcher`, run:

```bash
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

If formatting is needed, run the child package’s formatter only, inspect the diff, then rerun `format:check`.

Confirm that `npm pack --dry-run` works even though `private: true` blocks `npm publish`, and verify that the archive contains only intended package files.

### Superproject checks

From `/workspace/projects/pi`, use pnpm from the root:

```bash
pnpm install
pnpm --filter @arcanemachine/pi-model-switcher run format:check
pnpm --filter @arcanemachine/pi-model-switcher run typecheck
pnpm --filter @arcanemachine/pi-model-switcher run test
pnpm --filter @arcanemachine/pi-model-switcher run build
pnpm run typecheck
pnpm run test
```

Use the project’s documented Vitest capture workaround if the harness returns suspiciously empty output. Do not misreport empty capture as proof of passing tests.

Run `git diff --check` in both the child and superproject. Inspect both diffs and statuses separately. Ensure no sibling package changed.

### Running-Pi verification

Ask the user before initiating user-facing runtime verification and before making any real model switch that could affect cost or provider usage. Exercise the extension from the main checkout, not a temporary copy.

Verify at least:

1. Default startup with no setting/flag is disabled.
2. `/model-switcher` shows the concise default status with no confusing source label.
3. Both tools remain present while disabled.
4. Calling either tool while disabled returns the approved permission guidance and the list tool exposes no models.
5. `/model-switcher enable` shows the exact user notification and conveys the hidden agent message.
6. Authorized `model_switcher_list` returns only models inside Pi scope and the configured allow policy; query and refresh fallback behavior work.
7. An authorized switch to a user-approved test target takes effect on the following model continuation and Pi records its native model/thinking entries.
8. A disallowed or out-of-scope target is rejected.
9. `/model-switcher disable` immediately restores both tool gates without removing either tool.
10. Resume/reload restores an explicit toggle; `/new` and fork reapply baseline permission.
11. `--model-switcher-allow`, `--model-switcher-deny`, and the both-flags deny-wins case establish the correct new-session baseline.
12. Global and trusted-project settings merge as documented, including project `allow: "all"` overriding a global array.

Because this is user-facing behavior, obtain explicit user approval of the observed runtime behavior, or an explicit user-initiated waiver, before accepting the implementation, recording completion, or finalizing integration. If runtime behavior differs from this plan, fix it and repeat the affected checks rather than documenting the discrepancy as acceptable.

## Scope boundaries and stop conditions

### In scope

- The two agent tools
- The one user command and its autocomplete
- The two boolean CLI flags
- Global/trusted-project settings resolution
- Session permission persistence and lifecycle reset behavior
- Exact optional extension allowlist layered under Pi-native scope
- Package docs, tests, and superproject integration

### Out of scope

- An interactive model picker UI
- A user command that changes the allowlist
- Glob/fuzzy allowlist syntax
- Per-model cost limits or budgets
- Provider login/authentication flows
- Changing Pi’s native `enabledModels`, `--models`, default model, or default thinking settings
- Dynamically adding/removing active tools
- npm release, npm publication, tags, push, or release changelog
- Backward compatibility for unreleased scalar settings
- Refactoring sibling extensions or Pi itself

Stop and return to the user if:

- Pi’s current APIs cannot keep both tools active while enforcing the runtime gate;
- selecting a model from a tool cannot safely affect the next model continuation;
- the existing child repository cannot be registered as a submodule without destructive replacement;
- implementation requires a new runtime dependency not named in this plan;
- exact allowlist behavior conflicts with Pi scope or dynamic-model refresh behavior;
- user-facing verification cannot be performed or reveals materially different behavior;
- unrelated dirty state appears in either repository;
- package/release requirements change.

Do not broaden scope to solve hypothetical future requirements.

## Commit and completion sequence

The user has authorized committing this plan file. That authorization does not itself authorize implementation commits; execution must be assigned separately.

When implementation is assigned:

1. Inspect child and superproject status before changing anything. Preserve unrelated work.
2. Implement and document the child package without committing generated output.
3. Prepare the superproject integration without flattening the child repository.
4. Run all deterministic checks in both repositories.
5. Perform the approved running-Pi verification and obtain the required user acceptance or waiver.
6. Commit the coherent verified child implementation first, using a durable Conventional Commit such as:

   ```text
   feat: add user-authorized model switching
   ```

7. Complete the mandatory plan-file cleanup described in the final section and commit that child change.
8. Stage only `.gitmodules`, the final child gitlink, root `package.json`, root `README.md`, and `pnpm-lock.yaml` in the superproject.
9. Re-run appropriate root verification against the exact final child commit referenced by the gitlink.
10. Commit the superproject integration with a durable message such as:

    ```text
    feat: add pi-model-switcher package
    ```

11. Do not push or publish.
12. Report changed files, child/root commits, verification results, runtime acceptance status, and any deliberately deferred work faithfully.

## Final mandatory cleanup

After the implementation is complete, verified in the main checkout, accepted by the user (or explicitly waived by the user), and committed in the child repository, delete `packages/pi-model-switcher/PLAN.md`.

Commit that deletion in the child repository before staging the superproject’s final submodule pointer. The cleanup commit message must be durable and must not mention transient plan/session metadata; use a message such as:

```text
chore: finalize initial extension work
```
