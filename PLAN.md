# Strict model-and-thinking aliases

## Objective

Change model aliases from string model references into strict model presets that always specify both a canonical model and an exact Pi thinking level.

```json
{
  "model-switcher": {
    "aliases": {
      "research": {
        "model": "openai-codex/gpt-5.6-luna",
        "thinkingLevel": "xhigh"
      },
      "worker": {
        "model": "opencode-go/glm-5.3-flash",
        "thinkingLevel": "high"
      }
    }
  }
}
```

There is no compatibility with string-form aliases and no inferred or fallback thinking level.

## Required behavior

### Configuration

- Represent aliases as `Record<string, { model: string; thinkingLevel: ThinkingLevel }>`.
- Keep the existing lowercase alias-name validation.
- Require each alias value to be a non-array object with exactly the `model` and `thinkingLevel` keys.
- Require `model` to be an exact normalized canonical `provider/model` identifier.
- Require `thinkingLevel` to be one of Pi's exact levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- Reject missing fields, extra fields, string-form aliases, invalid model identifiers, and invalid thinking levels by ignoring the invalid alias and emitting a warning.
- Preserve current global/trusted-project replacement semantics for the complete `aliases` object.
- Do not add compatibility parsing or defaults.

### Listing and inspection

- Keep exactly the existing three always-registered sequential tools.
- Keep `model_switcher_list` as one combined alias-and-model listing.
- Format aliases as concise presets, for example:
  `- research → openai-codex/gpt-5.6-luna · thinking: xhigh`.
- Remove alias status from text and structured details.
- Represent returned aliases as an object keyed by alias name, with nested `model` and `thinkingLevel` fields.
- Preserve deterministic alias sorting, querying, empty states, independent 200-item bounds, refresh fallback, authorization gating, and available-model output.
- Match alias queries against alias name, model, and thinking level.
- Update `/model-switcher aliases` to show the same model-and-thinking preset information without changing permission.

### Switching

- Continue accepting either an exact canonical identifier or an exact alias.
- Resolve an alias to both its model and configured thinking level.
- Preserve Pi-native scope and the extension allowlist; aliases must never widen either policy.
- Validate that the target model supports the configured thinking level before mutating model or thinking state, using Pi's native supported-thinking-level logic rather than duplicating it.
- Reject unsupported combinations without switching or clamping.
- When the target model differs, switch the model and then apply the alias thinking level.
- When the model already matches but thinking differs, change only the thinking level.
- Treat the operation as a no-op only when both model and thinking already match.
- Alias thinking takes precedence over global defaults, per-model defaults, and scoped thinking pins. Direct canonical switching retains existing behavior.
- Verify the effective thinking level after applying the alias. Never falsely report that the exact preset was applied.
- Return concise text and structured details containing the alias, resolved model, configured/effective thinking level, and no-op state.

### Graceful errors

Handle these without false success or unintended mutation:

- unknown alias input;
- unavailable target model;
- target outside Pi's native scope;
- target blocked by the extension allowlist;
- unsupported thinking level;
- provider authentication failure between listing and switching;
- unexpected effective thinking level after applying a validated preset.

No-match list queries return explicit empty alias and model sections rather than errors.

## Implementation scope

Expected child-package changes:

- `src/index.ts`
- `tests/index.test.ts`
- `README.md`
- `package.json` only if Pi's supported-thinking helper requires a newly declared direct peer/dev dependency

Update the root lockfile only if dependency metadata changes. Do not modify unrelated packages or publish, push, tag, version, or release anything.

The user's live settings are outside the repository. Do not modify them without explicit authorization.

## Tests

Add or update focused coverage for:

- strict object normalization and exact field validation;
- rejection of string-form aliases and missing, extra, or invalid fields;
- trusted project replacement and untrusted project exclusion;
- combined listing text and keyed structured alias details;
- query matching by alias, model, and thinking level;
- deterministic ordering, empty states, and independent truncation;
- denied listing without alias/model disclosure;
- exact alias model-and-thinking switching;
- same-model thinking-only changes;
- true no-op behavior;
- precedence over scoped thinking pins;
- unavailable, out-of-scope, allowlist-blocked, and unsupported targets without mutation;
- provider failure and post-application invariant handling;
- `/model-switcher aliases` output and lack of permission/session side effects;
- retention of the three stable sequential tools.

## Documentation

Refresh the README examples and explanations so only the strict object schema is documented. Explain required fields, exact levels, no fallback/clamping, combined listing, switching semantics, native-scope/allowlist enforcement, configuration replacement, and graceful failures. Do not document string aliases as supported.

## Verification

Before committing, verify from the child package:

```bash
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
git diff --check
```

Exercise the user-facing behavior against a running Pi session from the main checkout, including alias inspection, combined listing, exact model-and-thinking application, same-model thinking changes, and graceful rejection.

Then verify from the superproject root:

```bash
pnpm run typecheck
pnpm run test
git diff --check
```

Do not run the destructive root formatter.

## Completion and commits

- Remove `PLAN.md` after every planned item is implemented and verified.
- Commit the coherent child implementation only after `PLAN.md` has been removed, so the plan and its removal do not remain in repository history.
- Use a Conventional Commit message for the child.
- Commit the child repository before committing the superproject submodule pointer and any required lockfile change.
- Leave both repositories clean and do not push.
