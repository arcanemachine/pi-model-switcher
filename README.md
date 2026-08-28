# pi-model-switcher

`pi-model-switcher` is a private, unreleased [Pi](https://pi.dev) extension for user-authorized agent-driven model switching. It reports the active model, lists Pi's currently permitted models, and switches by exact canonical identifier or configured alias.

Loading the extension never grants permission. Switching is denied by default.

## Quick start

Ask the user to allow switching for the current session:

```text
/model-switcher allow
```

Configure aliases in `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json`:

```json
{
  "model-switcher": {
    "allowed": true,
    "allow": "all",
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

Aliases require both `model` and `thinkingLevel`. Valid thinking levels are exactly `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. There are no string aliases, inferred levels, fallbacks, or clamping.

After authorization, call `model_switcher_list`, then pass an exact canonical identifier or alias to `model_switcher`:

```json
{ "model": "smart" }
```

An agent cannot authorize itself. If switching is denied, ask the user to run `/model-switcher allow`.

## Tools

The extension always registers exactly three sequential tools. Permission changes never alter the active tool set, preserving prompt-cache stability.

### `model_switcher_whoami`

Always available and read-only. Reports the live `provider/model` identifier and thinking level from Pi. When switching is denied, it includes a reminder to ask the user for authorization.

### `model_switcher_list`

Requires user authorization. Refreshes Pi's model registry and lists aliases and available models together. The optional `query` filters aliases by name, model, or thinking level, and models by canonical identifier or display name. A query matching an alias also includes its permitted target model.

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

Refresh failures fall back to Pi's cached registry and are reported in the response. A query with no matches returns explicit empty sections.

### `model_switcher`

Requires user authorization. Accepts an exact canonical `provider/model` identifier or exact configured alias. An alias sets both its model and thinking level. Alias presets never broaden Pi's native scope or bypass the extension allowlist.

If the model is already active, an alias can change only the thinking level. An operation is a no-op only when both model and thinking level already match. Alias thinking takes precedence over native defaults and scoped thinking pins. Direct canonical switching retains native behavior.

The target model must support the alias's exact thinking level. Unsupported combinations are rejected before any model or thinking mutation; Pi never clamps alias levels. The effective level is checked after application as a defensive invariant.

## Aliases

Aliases are configured under `model-switcher.aliases` as strict name-to-preset mappings:

```json
{
  "model-switcher": {
    "aliases": {
      "research": {
        "model": "provider/model",
        "thinkingLevel": "xhigh"
      }
    }
  }
}
```

Alias names must match `[a-z][a-z0-9_-]{0,63}`. They cannot contain `/` or point to another alias. Targets must be exact canonical identifiers; model IDs may contain additional slashes.

Inspect aliases without changing permission:

```text
/model-switcher aliases
```

The command and authorized listing show aliases sorted by name with their model and thinking level. Global aliases are used unless a trusted project defines its own `aliases` object. A trusted project's object replaces the global object; it is not merged key-by-key. Untrusted project settings are ignored.

Invalid alias entries are ignored with a warning. This includes invalid names, string values, missing or extra fields, invalid models, and invalid thinking levels. Invalid entries do not affect otherwise valid canonical model switching.

## Permission

Show the effective state:

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

```text
--model-switcher-allow
--model-switcher-deny
```

If both flags are supplied, deny wins. Effective precedence is session override, CLI flag, configuration, then denied default. `/model-switcher aliases` does not change permission or create a session entry.

## Settings

The extension reads global `~/.pi/agent/settings.json` and the trusted project's `.pi/settings.json`. Trusted project fields override corresponding global fields. Arrays replace arrays, and the `aliases` object replaces the global alias object when supplied.

Allow every model in Pi's current native scope:

```json
{
  "model-switcher": {
    "allowed": true,
    "allow": "all"
  }
}
```

Narrow switching to an exact allowlist:

```json
{
  "model-switcher": {
    "allowed": true,
    "allow": ["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"],
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

Invalid `allowed` settings deny switching. An invalid `allow` value permits no models; invalid array entries are ignored while valid entries remain. Invalid aliases are ignored as described above.

## Installation and development

This package is private (`0.0.0`) and has no npm installation or release path. For local development, install its declared dependencies and load the source entry point:

```bash
npm install --ignore-scripts --workspaces=false
pi -e /path/to/pi-model-switcher/src/index.ts
```

Package checks:

```bash
npm run format:check
npm run typecheck
npm run test
npm run build
npm pack --dry-run
```

## Safety and scope

The extension uses Pi's live model registry and native scope. It does not invent models, authenticate providers, bypass provider errors, or clamp alias thinking levels. Denied requests fail before refreshing or disclosing model and alias inventory. Alias resolution is exact and policy-preserving. Permission changes send hidden session context without triggering unsolicited agent turns.

## License

MIT
