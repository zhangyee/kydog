# pi coding-agent (vendored reference)

Reference material for the pi coding-agent SDK, vendored into KyDog.

- **Upstream**: https://github.com/badlogic/pi-mono
- **Synced commit**: `da6a81d3986d00f9648384e68de04c720cc3a96b` (2026-04-20)
- **Upstream subpath**: `packages/coding-agent/`
- **License**: MIT © 2025 Mario Zechner — see [`LICENSE`](./LICENSE)

## Purpose

Reference only. These files are **not** imported by KyDog, **not** bundled
into the Electron app, and **not** compiled. They exist so contributors (and
AI coding assistants) can consult the upstream SDK surface and examples
while working on KyDog.

## Contents

| Path | Upstream source |
|---|---|
| `docs/sdk.md` | `packages/coding-agent/docs/sdk.md` |
| `examples/sdk/` | `packages/coding-agent/examples/sdk/` |
| `LICENSE` | root `LICENSE` of pi-mono |

## Re-syncing

When the upstream SDK evolves, refresh this directory with:

```bash
UPSTREAM=/path/to/local/pi-mono    # or clone fresh
rm -rf docs examples LICENSE
mkdir -p docs examples
cp "$UPSTREAM/packages/coding-agent/docs/sdk.md"      docs/sdk.md
cp -R "$UPSTREAM/packages/coding-agent/examples/sdk"  examples/sdk
cp "$UPSTREAM/LICENSE"                                LICENSE
# then update the commit hash and sync date above
```
