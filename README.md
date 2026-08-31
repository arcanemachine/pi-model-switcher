# pi-model-switcher

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/pi-model-switcher/main/logo.jpg" alt="pi-model-switcher logo" width="250" />
</p>

A [Pi](https://pi.dev) extension for user-authorized agent-driven model switching.

It reports the active model, lists Pi's currently permitted models and configured aliases, and switches models only after you authorize it for the current session. Loading the extension never grants permission: switching is denied by default.

> Like this extension? See [my other Pi extensions](https://github.com/arcanemachine/pi-projects).

## Requirements

- Pi 0.84.1 or later
- Node.js 22.19.0 or later for package development

## Installation

From GitHub:

```bash
pi install git:github.com/arcanemachine/pi-model-switcher
```

From npm:

```bash
pi install npm:@arcanemachine/pi-model-switcher
```

For local development:

```bash
pi -e ./src/index.ts
```

## Quick start

1. Start Pi with the extension installed.
2. Check the current permission state:

   ```text
   /model-switcher
   ```

3. Allow model switching for the current session:

   ```text
   /model-switcher allow
   ```

4. Ask the agent to show the available models, then ask it to switch to the model you want. You can use an exact provider/model identifier or a configured alias.
5. When you are finished, deny switching again:

   ```text
   /model-switcher deny
   ```

If switching is denied, the agent should ask you to run `/model-switcher allow`. An agent cannot authorize itself.

## Permission

Show the effective permission state without changing it:

```text
/model-switcher
```

Change authorization for the current session:

```text
/model-switcher allow
/model-switcher deny
```

These commands persist an explicit override on the active session branch. Resuming or reloading restores that branch's latest override. `/new` and forks start from the flag/configuration baseline; a fork records a reset when it inherited an explicit authorization.

For a new session, use either CLI flag:

```bash
--model-switcher-allow
--model-switcher-deny
```

If both flags are supplied, deny wins. Effective precedence is session override, CLI flag, configuration, then denied default.

## Aliases

Aliases let you give a short name to a model and its thinking level. Configure them under `model-switcher.aliases` as strict name-to-preset mappings:

```json
{
  "model-switcher": {
    "aliases": {
      "smart": {
        "model": "anthropic/claude-sonnet-4-5",
        "thinkingLevel": "high"
      },
      "worker": {
        "model": "openai/gpt-5.4",
        "thinkingLevel": "medium"
      }
    }
  }
}
```

After authorization, an alias name works anywhere an exact model identifier works:

```json
{ "model": "smart" }
```

Inspect aliases without changing permission:

```text
/model-switcher aliases
```

The aliases command does not change permission or create a session entry.

Alias names must match `[a-z][a-z0-9_-]{0,63}`. They cannot contain `/` or point to another alias. Targets must be exact canonical identifiers; model IDs may contain additional slashes.

The command and authorized listing show aliases sorted by name with their model and thinking level. Global aliases are used unless a trusted project defines its own `aliases` object. A trusted project's object replaces the global object; it is not merged key-by-key. Untrusted project settings are ignored.

Invalid alias entries are ignored with a warning. This includes invalid names, string values, missing or extra fields, invalid models, and invalid thinking levels. Invalid entries do not affect otherwise valid canonical model switching.

## Settings

The extension reads global `~/.pi/agent/settings.json` and the trusted project's `.pi/settings.json`. Trusted project fields override corresponding global fields. Arrays replace arrays, and the `aliases` object replaces the global alias object when supplied.

Allow every model in Pi's current native scope:

```json
{
  "model-switcher": {
    "allowed": true,
    "allowedModels": "all"
  }
}
```

Narrow switching to an exact `allowedModels` list:

```json
{
  "model-switcher": {
    "allowed": true,
    "allowedModels": ["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"],
    "aliases": {
      "smart": {
        "model": "anthropic/claude-sonnet-4-5",
        "thinkingLevel": "high"
      }
    }
  }
}
```

Pi's `enabledModels` setting and `--models` flag remain authoritative; this extension can only narrow that scope. Aliases likewise only name targets that already pass those policies.

Omitting `allowedModels` means `"all"`; an empty array permits no models. Array entries must be exact canonical identifiers, with invalid entries ignored and duplicates removed. An invalid `allowedModels` value permits no models. The separate `allowed` setting controls authorization, not the model policy.

The old `allow` setting is unsupported and is never interpreted. If it is present in the effective trusted configuration, the extension warns and permits no models rather than widening the policy. Invalid aliases are ignored as described above.

## Technical reference

The extension registers exactly three sequential tools. Permission changes never alter the active tool set, preserving prompt-cache stability.

### `model_switcher_whoami`

Always available and read-only. Reports the live model and thinking level as `model (thinkingLevel)`. When switching is denied, it includes a reminder to ask the user for authorization.

### `model_switcher_list`

Requires user authorization. Refreshes Pi's model registry and lists all configured aliases and currently permitted models together. It takes no arguments. Aliases are shown with their configured targets, including targets that are unavailable or blocked by current policy, so the agent can distinguish configuration from availability.

Aliases are sorted by name and models by provider/model. Each section is capped at 200 results. Structured alias details are keyed by alias name:

```json
{
  "aliases": {
    "smart": {
      "model": "anthropic/claude-sonnet-4-5",
      "thinkingLevel": "high"
    }
  }
}
```

Refresh failures fall back to Pi's cached registry and are reported in the response. Empty sections explicitly distinguish no configured aliases from no currently available or permitted models.

### `model_switcher_switch`

Requires user authorization. Accepts an exact canonical `provider/model` identifier or exact configured alias. An alias sets both its model and thinking level. Alias presets never broaden Pi's native scope or bypass the `allowedModels` policy.

If the model is already active, an alias can change only the thinking level. An operation is a no-op only when both model and thinking level already match. Alias thinking takes precedence over native defaults and scoped thinking pins. Direct canonical switching retains native behavior.

The target model must support the alias's exact thinking level. Unsupported combinations are rejected before any model or thinking mutation; Pi never clamps alias levels. The effective level is checked after application as a defensive invariant.

After a successful state change, the tool response reports the resulting model and thinking level as `model (thinkingLevel)`, including the alias when one was used. The extension does not emit a separate info notification, so the result is not duplicated. No-op and failed operations are not accompanied by a separate notification.

## Safety and scope

The extension uses Pi's live model registry and native scope. It does not invent models, authenticate providers, bypass provider errors, or clamp alias thinking levels. Denied requests fail before refreshing or disclosing model and alias inventory. Alias resolution is exact and policy-preserving; aliases cannot bypass the `allowedModels` policy. Permission changes send hidden session context without triggering unsolicited agent turns.

## Development

```bash
npm install --ignore-scripts --workspaces=false
npm run typecheck
npm run test
npm run build
npm run format
npm pack --dry-run
```

The package is source-loaded by Pi from `src/index.ts`; no compiled runtime artifact is required.

## License

MIT
