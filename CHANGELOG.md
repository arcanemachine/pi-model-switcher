# Changelog

## 0.1.0 - 2026-08-28

- Add user-authorized agent-driven model switching with `model_switcher_whoami`, `model_switcher_list`, and `model_switcher_switch`.
- Deny switching by default; permission comes only from the user via `/model-switcher allow`, `--model-switcher-allow`, or trusted configuration.
- Add strict model aliases with exact model targets and thinking levels, resolved without widening Pi's native scope or the `allowedModels` policy.
- Add `allowedModels` policy support that can only narrow Pi's native scope, with invalid values failing closed.
- Report live model identity, aliases, and available models with deterministic ordering and 200-entry caps; the listing tool takes no arguments and always returns the complete permitted inventory.
- Keep the three registered tools stable regardless of permission so the prompt-cache prefix is preserved.
- Persist permission overrides on the active session branch and restore them across reload and resume; `/new` and forks reset to the flag/configuration baseline.
- Report switch results as `model (thinkingLevel)` in tool output without duplicate notifications.
