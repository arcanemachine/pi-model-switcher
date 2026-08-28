# pi-model-switcher

`pi-model-switcher` is a private, unreleased [Pi](https://pi.dev) extension for user-authorized agent-driven model switching. It helps an agent identify the active model, discover the models Pi currently permits, and select a model by its exact identifier or a memorable alias.

Loading the extension never grants permission. Switching is denied by default so the user remains in control of provider access, cost, and session behavior.

## Quick start

Add the extension to a Pi run, then ask the user to allow switching:

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
      "smart": "anthropic/claude-sonnet-4-5",
      "worker": "openai/gpt-5.4"
    }
  }
}
```

After authorization, call `model_switcher_list`. It returns aliases and available models together in one deterministic response. Pass either an exact canonical identifier or an exact alias to `model_switcher`:

```json
{ "model": "smart" }
```

An agent cannot authorize itself. If switching is denied, ask the user to run `/model-switcher allow` instead of retrying the gated tools.

## Tools

The extension always registers exactly three sequential tools. Permission changes never alter the active tool set, preserving prompt-cache stability.

### `model_switcher_whoami`

Always available and read-only. Reports the live `provider/model` identifier and thinking level from Pi. When switching is denied, it includes a concise reminder for the agent to ask the user for authorization.

### `model_switcher_list`

Requires user authorization. Refreshes Pi's model registry and lists both configured aliases and permitted models in one response. The optional `query` filters both sections by alias name, canonical target, model identifier, or model display name. A query matching an alias also includes its target model when that model is permitted.

Aliases are sorted by name and models by provider/model. Each section is capped at 200 results. The structured result includes deterministic alias status values:

- `available` — the target is in Pi's native scope and passes the extension allowlist;
- `blocked-by-allowlist` — the target is in native scope but excluded by `allow`;
- `outside-native-scope` — the target is available to Pi but excluded by its native scope;
- `unavailable` — the target is not currently available or authenticated.

Alias entries remain visible when their targets are blocked or unavailable, so an agent can understand why an alias cannot be used. Refresh failures fall back to Pi's cached registry and are reported in the response.

### `model_switcher`

Requires user authorization. Accepts an exact canonical `provider/model` identifier or an exact configured alias. An alias resolves to its target, but never broadens Pi's native scope or bypasses the extension allowlist. Scoped thinking-level settings are applied after a successful switch.

Using an alias reports both values:

```text
Switched to anthropic/claude-sonnet-4-5 via alias "smart". Thinking: high
```

A target that is unavailable, outside native scope, or blocked by the allowlist is rejected without calling Pi's model-switch API.

## Aliases

Aliases are configured under `model-switcher.aliases` as exact name-to-target mappings:

```json
{
  "model-switcher": {
    "aliases": {
      "smart": "provider/model",
      "worker": "other/provider/model"
    }
  }
}
```

Alias names must match `[a-z][a-z0-9_-]{0,63}`. They are lowercase, cannot contain `/`, and cannot point to another alias. Targets must be exact canonical identifiers; model IDs may contain additional slashes.

Use the user command to inspect mappings without changing permission:

```text
/model-switcher aliases
```

The command prints aliases sorted by name. Authorized agents receive the same mappings, with live status, from `model_switcher_list`.

Global aliases are used unless a trusted project defines its own `aliases` object. A trusted project's alias object replaces the global object; it is not merged key-by-key. Untrusted project settings are ignored.

Invalid alias entries are ignored with a warning. Invalid names, invalid targets, duplicate names after trimming, and non-object `aliases` values do not grant access or deny otherwise valid canonical model switching. Unknown but well-formed targets remain configured and appear as `unavailable` until Pi provides them.

## Permission

Show the current effective state:

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

If both flags are supplied, deny wins. Effective precedence is:

1. session command override;
2. CLI flag;
3. configuration;
4. denied default.

The status line identifies `session`, `flag`, or `config` sources when applicable. The denied default has no source label. `/model-switcher aliases` is a direct user inspection command and does not change permission or create a session entry.

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
      "smart": "anthropic/claude-sonnet-4-5"
    }
  }
}
```

Permit no target models intentionally with `"allow": []`. Omitting `allow` means every model in Pi's current native scope, not every model known to the extension. Pi's `enabledModels` setting and `--models` flag remain authoritative; this extension can only narrow that scope. Aliases likewise only name targets that already pass those policies.

Invalid `allowed` settings deny switching. An invalid `allow` value permits no models; invalid array entries are ignored while valid entries remain. Invalid alias entries are ignored as described above.

## Installation and development

This package is currently private (`0.0.0`) and has no npm installation or release path. For local development, install its declared dependencies and load the source entry point:

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

The extension uses Pi's live model registry and native scope. It does not invent models, authenticate providers, or bypass provider errors. Denied requests fail before refreshing or disclosing model and alias inventory. Alias resolution is exact and policy-preserving. Permission changes send hidden session context without triggering unsolicited agent turns.

## License

MIT
