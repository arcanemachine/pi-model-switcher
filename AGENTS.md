# pi-model-switcher guidance

- Commit coherent completed work in this child repository with Conventional Commit messages.
- Run package-local `npm run format:check`, `npm run typecheck`, `npm run test`, and `npm run build` before completion.
- Verify user-facing changes against a running Pi session before release or acceptance.
- Do not push or publish without explicit authorization. Do not release while `private: true` and version `0.0.0` remain.
- Commit the child repository before committing its superproject submodule pointer or integration changes.
