# pi-model-switcher

`pi-model-switcher` is a private, unreleased Pi extension for user-authorized agent-driven model switching. It is opt-in to avoid unexpected provider use and cost: loading the extension never grants permission.

## Tools

- `model_switcher_whoami` is always available. It reads Pi's live model and thinking state, reports the canonical `provider/model` identifier, and adds a concise reminder when switching is unauthorized.
- `model_switcher_list` lists permitted models after the user authorizes agent-driven model switching.
- `model_switcher` selects an exact canonical identifier returned by the list tool.

The list and switch tools share a runtime authorization gate. They fail without disclosing model inventory when permission is disabled. All three tools remain registered and execute sequentially; permission changes never alter the active tool set.

## Permission

Use `/model-switcher` to show status, `/model-switcher enable` to authorize the agent for the current session, or `/model-switcher disable` to revoke that authorization. Enable and disable changes are persisted for the active session branch. The status line shows `source: session`, `source: flag`, or `source: config` when applicable; the disabled default has no source label.

For a new session, the CLI flags are:

```text
--model-switcher-allow
--model-switcher-deny
```

If both are supplied, deny wins. A command toggle can override either flag for the current session. Permission precedence is: session command, flag, configuration, disabled default. Resuming or reloading restores the active branch's explicit toggle. `/new` and a fork start from the baseline; a fork writes a reset entry when it inherited an authorization.

## Settings

The extension reads the global `~/.pi/agent/settings.json` and the trusted project's `.pi/settings.json`. Trusted project fields override corresponding global fields; arrays replace arrays. Untrusted project settings are ignored.

Allow all models in Pi's native scope:

```json
{
  "model-switcher": {
    "enabled": true,
    "allow": "all"
  }
}
```

Narrow to an exact allowlist:

```json
{
  "model-switcher": {
    "enabled": true,
    "allow": ["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"]
  }
}
```

Permit no target models intentionally:

```json
{
  "model-switcher": {
    "enabled": true,
    "allow": []
  }
}
```

Omitting `allow` means all models in Pi's current native scope, not every model known to the extension. Pi's `enabledModels` setting and `--models` flag remain authoritative; this extension can only narrow that scope. Identifiers are exact `provider/model` strings. Model IDs may contain additional slashes.

Invalid settings fail safe: invalid `enabled` disables switching, an invalid `allow` value permits no models, and invalid array entries are ignored while valid entries remain. Unknown but well-formed identifiers simply produce no current candidate.

## Installation and use

For local development, load `./src/index.ts` with Pi's extension option. A Git checkout can be loaded the same way after installing its declared dependencies. The Pi projects superproject can use the package's `pi` manifest for its extension path.

This package is currently private (`0.0.0`) and has no npm installation or release path.

## Example

Ask the user to run `/model-switcher enable`, then use `model_switcher_list` and pass one of its exact identifiers to `model_switcher`. An agent cannot authorize itself. To inspect identity without permission, call `model_switcher_whoami`.
