export type FixtureEvent =
  | { after_ms: number; type: 'agent_start' }
  | { after_ms: number; type: 'message_start'; messageId: string }
  | { after_ms: number; type: 'text_delta'; messageId: string; delta: string }
  | { after_ms: number; type: 'thinking_delta'; messageId: string; delta: string }
  | { after_ms: number; type: 'tool_start'; toolCallId: string; name: string; command: string; args?: Record<string, unknown> }
  | { after_ms: number; type: 'tool_chunk'; toolCallId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { after_ms: number; type: 'tool_end'; toolCallId: string; status: 'ok' | 'failed'; exitCode: number }
  | {
      after_ms: number;
      type: 'message_end';
      messageId: string;
      toolCallIds?: string[];
      /** 与 toolCallIds 同序的工具名；缺省按 'bash' 处理。批次里含 ask 时必须如实写出。 */
      toolNames?: string[];
    }
  | {
      type: 'ask';
      after_ms: number;
      toolCallId: string;
      /** 直接用模型原始形状；fixture session 会把它交给真实的工具走一遍校验和 broker。 */
      questions: Array<{
        question: string;
        header: string;
        multiSelect?: boolean;
        options: Array<{ label: string; description: string; recommended?: boolean }>;
      }>;
    }
  | {
      after_ms: number;
      type: 'tool';
      toolCallId: string;
      /**
       * 已注册的 customTool 的名字。**fixture 真去执行它** —— 与上面的 `ask` 同一个
       * 机制（那一条真调 `askUserQuestionTool.execute`），只是把「只有 ask 一种」补齐
       * 成「按名字找任意一个已注册的工具」。
       *
       * 找得到的名字取决于 `sessionFactory` 交给 fixture session 的那份工具清单 ——
       * 目前是 `createBrowserTools()` 那五个（`browser_open` / `browser_act` /
       * `browser_read` / `browser_login` / `browser_tabs`），与非 fixture 分支交给
       * pi 的是**同一次构造**。名字不在清单里时这一条按工具失败处理
       * （`isError: true`），不静默跳过。
       *
       * ── 写 fixture 剧本不再是零副作用的事 ────────────────────────────────
       *
       * 「真去执行」的另一半含义：**这些工具有真实的外部副作用，写在剧本里就等于
       * 真的做一遍**。别的事件（`text_delta` / `tool_start` / `tool_end` …）都只是
       * 把字节喂给渲染层，这一条不是。
       *
       *  · `browser_open` / `browser_act` **真的打公网**（内置浏览器的 urlGuard 只放行
       *    公网 http/https，起不了本地夹具服务器 —— 见 `e2e/61-browser.spec.ts` 文件头）。
       *  · `browser_login` **真的用设置里存着的校园统一身份认证账号密码往当前页提交
       *    一次登录**。而它的语义是「同一轮任务里失败一次就停手」（`browser.login_attempted`），
       *    高校 IdP 普遍锁定连续失败的账号 —— **押的是用户自己的校园账号，而且本轮
       *    只有这一次机会**。
       *
       * 所以加用例之前先确认这条剧本打到的是不是该打的地方：URL 是不是受控的、
       * 那一步会不会走到 `browser_login`、当前设置里有没有真凭据。
       * **这段话必须留在这份 tracked 文件里** —— 它一度只登记在 `.superpowers/` 的
       * 交接报告里，而那棵树被 `.gitignore` 挡在 git 之外，合并之后下一个人看不到
       * （与 `eventLedger.test.ts` 开头点名的是同一个失败形状）。
       */
      name: string;
      /** 原样交给工具的 `execute` —— 模型给的参数长什么样，这里就长什么样。 */
      args: Record<string, unknown>;
    }
  | { after_ms: number; type: 'agent_end'; reason: 'completed' | 'aborted' | 'error'; errorMessage?: string };

import { decodeUserTurn } from '../../src/shared/userTurn';

/** 假会话自称的模型能收什么输入；缺省 ['text', 'image']。 */
type FixtureModel = { modelInput?: ('text' | 'image')[] };

/**
 * 两种形状：
 *  · `events` —— 一份剧本，每一轮不管用户发了什么都整份重放（老 fixture 都是这种）。
 *  · `scripts` —— 按这一轮用户发的正文（去掉结构块、trim 后逐字）挑剧本。让同一次启动里的几个流式
 *    场景共用一份 fixture，不必每个场景冷启动一次应用。认不到名字就当场抛错并列出有哪些
 *    剧本，**不回落**到任何一份 —— 静默回落会让用例在错的剧本上变绿。
 */
export type FixtureFile =
  | ({ events: FixtureEvent[] } & FixtureModel)
  | ({ scripts: Record<string, FixtureEvent[]> } & FixtureModel);

/**
 * 这一轮该放哪份剧本。纯函数，单测直接测它。
 * `scripts` 按**正文**挑（结构块不参与）：带附件 / 批注的消息，剧本名只写正文那句。
 * 正文按 userTurn 的严格语法切出来 —— 图片数对不上时结构块不被承认，整条原文当 key。
 */
export function pickFixtureEvents(file: FixtureFile, content: string, imageCount = 0): FixtureEvent[] {
  if ('events' in file) return file.events;
  const key = decodeUserTurn(content, imageCount).bodyRaw.trim();
  const events = file.scripts[key];
  if (!events) {
    throw new Error(`fixture 里没有名为「${key}」的剧本；有：${Object.keys(file.scripts).map((k) => `「${k}」`).join('、')}`);
  }
  return events;
}
