# Model-switch notifications and `allowedModels`

## Objective

Make two focused changes to `pi-model-switcher`, in order:

1. Add an idiomatic user-facing notification after a successful agent-driven model or alias preset change.
2. Rename the model policy setting from `allow` to `allowedModels` throughout configuration, implementation, tests, and documentation.

The old `allow` setting has no compatibility behavior and is never interpreted as a model policy.

## Stage 1: successful-change notifications

### Behavior

Use `ctx.ui.notify(message, "info")` after the requested state has been applied and verified.

For an actual model change, notify with the previous model, new model, final thinking level, and alias when applicable:

```text
Model switched: provider/old → provider/new · thinking: high · alias: thinker
```

For a same-model alias that changes only thinking, use distinct and accurate wording:

```text
Thinking changed: provider/model · high → xhigh · alias: doer
```

For canonical model changes, omit the alias suffix.

### Timing and scope

- Notify only after `pi.setModel()` succeeds, any explicit alias thinking level is applied, and the effective thinking level passes the existing invariant check.
- Notify only from successful `model_switcher` tool execution.
- Do not subscribe to `model_select` or `thinking_level_select`; those events include unrelated native operations and can fire before an alias preset is fully applied.
- Do not send an additional agent/session message. The existing tool result remains the agent-facing and durable record.
- Do not notify for:
  - true no-ops;
  - denied requests;
  - unknown aliases or models;
  - unavailable, out-of-scope, or policy-blocked targets;
  - unsupported thinking levels;
  - provider/authentication failures;
  - post-application invariant failures.

### Tests

Add focused assertions that:

- an alias model change notifies once with previous model, new model, final thinking, and alias;
- a canonical model change notifies once without an alias;
- a same-model thinking-only alias notifies once with previous and new thinking;
- no-op and every existing failure path do not notify;
- notification occurs only after the effective thinking level is verified;
- the tool result continues to carry the agent-facing state.

## Stage 2: rename `allow` to `allowedModels`

### Configuration contract

The namespace becomes:

```json
{
  "model-switcher": {
    "allowed": true,
    "allowedModels": [
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-sol"
    ],
    "aliases": {
      "thinker": {
        "model": "openai-codex/gpt-5.6-sol",
        "thinkingLevel": "high"
      }
    }
  }
}
```

Preserve the current policy semantics:

- `"allowedModels": "all"` permits every model in Pi's native scope.
- `"allowedModels": []` permits no models.
- Omitting `allowedModels` means `"all"`.
- Array entries remain exact canonical `provider/model` identifiers.
- Invalid `allowedModels` types fail closed to no permitted models.
- Invalid array entries are ignored while valid exact entries remain.
- Duplicate valid entries are removed.

### No compatibility

- Never read, normalize, migrate, or apply the old `allow` value.
- If the `model-switcher` namespace contains `allow`, emit a warning and fail closed to no permitted models. This prevents omission semantics from widening an old restrictive configuration to `"all"`.
- A trusted project containing `allow` also fails closed rather than inheriting or combining with a global `allowedModels` policy.
- Do not support both names or add a deprecation period.

### Internal rename

Rename the implementation consistently rather than retaining stale terminology, including as applicable:

- `ModelSwitcherSettings.allow` → `ModelSwitcherSettings.allowedModels`;
- `ResolvedConfiguration.allow` → `ResolvedConfiguration.allowedModels`;
- `PermissionAllowPolicy` → `AllowedModelsPolicy`;
- `normalizeAllowPolicy` → `normalizeAllowedModelsPolicy`;
- `normalizeAllowlist` → `normalizeAllowedModels`;
- candidate-calculation parameters and local variables;
- test harness options and expectations;
- warnings and model-policy error text.

Keep permission terminology unchanged:

- `allowed` remains the configuration baseline for agent authorization;
- `/model-switcher allow` and `/model-switcher deny` remain user commands;
- `--model-switcher-allow` and `--model-switcher-deny` remain CLI flags;
- permission precedence and session persistence remain unchanged.

### Tests

Update and extend coverage for:

- `allowedModels: "all"`, exact arrays, empty arrays, omission, invalid types, mixed valid/invalid entries, and duplicates;
- global/trusted-project replacement behavior;
- untrusted project exclusion;
- exact intersection with Pi's native scope;
- old `allow` rejection with a warning and no permitted models;
- no accidental permission widening when old `allow` and `allowedModels` appear across global/project settings;
- unchanged authorization commands, flags, precedence, session persistence, three stable sequential tools, aliases, notifications, refresh fallback, listing, and switching.

## Documentation

Update `README.md` so every model-policy example and explanation uses `allowedModels`. Do not document `allow` as supported. Explain:

- the difference between authorization `allowed` and model policy `allowedModels`;
- `"all"`, empty-array, omission, native-scope intersection, and exact identifier semantics;
- invalid settings and fail-closed behavior;
- successful model/thinking notifications and their tool-local scope;
- the existing fact that aliases cannot bypass native scope or `allowedModels`.

Do not change unrelated root documentation or packages.

## Verification

Run from the child package:

```bash
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
git diff --check
```

Exercise the user-facing behavior in a running Pi process using a temporary trusted project configuration, without modifying live user settings. Verify:

- actual model-change notification;
- thinking-only notification;
- no notification for a no-op and a rejected operation;
- `allowedModels` exact restriction;
- old `allow` rejection without inventory or policy widening.

Then run from the superproject root:

```bash
pnpm install --frozen-lockfile --offline
pnpm run typecheck
pnpm run test
git diff --check
```

Do not run the destructive root formatter.

## Completion and commits

- Keep this plan committed while implementation proceeds.
- Remove `PLAN.md` only after both stages and all verification are complete.
- Commit the coherent child implementation, including plan removal, with a Conventional Commit message.
- Commit the child repository before committing the superproject submodule pointer.
- Leave both repositories clean.
- Do not push, publish, tag, version, or release anything.
