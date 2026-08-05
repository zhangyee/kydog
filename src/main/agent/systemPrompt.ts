// src/main/agent/systemPrompt.ts
import { ASK_GUIDELINES } from './askUserQuestionTool';

/**
 * KyDog 自己的系统提示词。
 *
 * pi 的 `buildSystemPrompt`（core/system-prompt.js）分两条路：拿到 `customPrompt` 就整段
 * 用它并提前 return；没拿到才拼自己那套「You are an expert coding assistant operating
 * inside pi, a coding agent harness…」+ 工具清单 + guidelines + pi 文档索引。KyDog 的身份
 * 只由 SOUL/USER/AGENTS 定义，不能让 pi 的默认人格排在它们前面，所以必须走 customPrompt
 * 那条路 —— 入口是 `DefaultResourceLoader` 的 `systemPromptOverride`（见 skillResourceLoader）。
 *
 * 提前 return 的代价：工具的 `promptGuidelines` 一条都不渲染。那些是跨工具的路由约定
 * （「用 read 而不是 cat」「write 只用于新文件或整份重写」），不在发给模型的 tool
 * description 里，丢了就是真丢了。所以下面从 pi 的工具定义现读现拼，不抄文案 ——
 * pi 改了它们，KyDog 跟着变。
 *
 * 仍由 pi 追加在这段之后的：`<project_context>`（SOUL/USER/AGENTS + 项目 agents 文件）、
 * `<available_skills>`、`Current working directory:` 行。
 */

const PREAMBLE = `你运行在 KyDog —— 一个面向科研工作流的桌面应用。用户在图形界面里与你对话，你的回复按 Markdown 渲染。

你是谁、为谁工作、按什么规矩做事，完整定义在下面 <project_context> 里的 SOUL.md（人格）、USER.md（用户）、AGENTS.md（操作手册）。它们不是「项目补充说明」，而是你本人的定义，也是唯一的角色设定。`;

export type ToolPromptSource = { name: string; promptGuidelines?: readonly string[] };

/**
 * KyDog 会话实际启用的 pi 内置工具。sessionFactory 不传 `tools`，吃的就是 pi 的默认集
 * （sdk.js `defaultActiveToolNames = ["read", "bash", "edit", "write"]`）。pi 若改默认集，
 * 这里最多是多一条/少一条 guideline，不影响工具本身可用性。
 */
async function builtinToolDefinitions(cwd: string): Promise<ToolPromptSource[]> {
  const pi = await import('@earendil-works/pi-coding-agent');
  return [
    pi.createReadToolDefinition(cwd),
    pi.createBashToolDefinition(cwd),
    pi.createEditToolDefinition(cwd),
    pi.createWriteToolDefinition(cwd),
  ];
}

export function renderSystemPrompt(builtins: readonly ToolPromptSource[]): string {
  const names = builtins.map((t) => t.name);
  const raw: string[] = [];
  // pi 只在有 bash、又没有 grep/find/ls 专用工具时才提示拿 bash 兜底（system-prompt.js 同款条件）。
  if (names.includes('bash') && !names.some((n) => n === 'grep' || n === 'find' || n === 'ls')) {
    raw.push('Use bash for file operations like ls, rg, find');
  }
  for (const tool of builtins) raw.push(...(tool.promptGuidelines ?? []));
  raw.push(...ASK_GUIDELINES);

  const guidelines = [...new Set(raw.map((g) => g.trim()).filter((g) => g.length > 0))];
  return `${PREAMBLE}\n\n工具约定：\n${guidelines.map((g) => `- ${g}`).join('\n')}`;
}

export async function buildKydogSystemPrompt(cwd: string): Promise<string> {
  return renderSystemPrompt(await builtinToolDefinitions(cwd));
}
