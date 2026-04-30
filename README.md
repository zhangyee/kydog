# KyDog

KyDog — a research AI agent GUI for academic literature discovery and synthesis.

## First launch

### macOS (unsigned MVP build)

The MVP is not yet Apple-signed/notarized, so Gatekeeper blocks the first launch.

1. System Settings → Privacy & Security
2. Scroll to bottom; under "KyDog was blocked" click **Open Anyway**

If the app still won't launch (occasionally on macOS 15.1+), run once in a terminal:

```bash
xattr -d com.apple.quarantine /Applications/KyDog.app
```

### Windows

1. Double-click the `.exe`. SmartScreen will warn → click **More info** → **Run anyway**
2. KyDog needs [Git for Windows](https://git-scm.com/download/win) for shell tool support. If it isn't installed, KyDog will prompt you on first launch — install Git, then restart KyDog.

## Bundled tools

KyDog ships with [fastpaper-cli](https://github.com/zhangyee/fastpaper-cli) (GPL-3.0) for academic paper search and download. The binary is bundled per platform; no separate install needed.
