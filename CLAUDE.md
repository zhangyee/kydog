# KyDog — Claude Code guidance

GPLv3 Electron 桌面应用，基于 pi coding-agent SDK 构建的科研 AI 智能体。

## References (vendored under `third_party/`)

当涉及下列主题时，**先查参考材料再动手**，不要凭记忆猜 API 形态。

| 主题 | 路径 | 何时查阅 |
|---|---|---|
| pi coding-agent SDK | `third_party/pi-coding-agent/docs/sdk.md` | 涉及 agent session、工具协议、SDK 类型、压缩/消息生命周期 |
| pi SDK 官方示例 | `third_party/pi-coding-agent/examples/sdk/README.md`（示例清单） | 编写集成代码时先看清单定位合适的示例再按需打开；不要整段复制进 `src/` |

`third_party/` 为上游只读镜像，已在 `tsconfig.json` 中 exclude，不参与编译/打包。
