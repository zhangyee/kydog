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
       * 目前是 `createBrowserTools()` 那四个（`browser_open` / `browser_act` /
       * `browser_read` / `browser_login`），与非 fixture 分支交给 pi 的是**同一次
       * 构造**。名字不在清单里时这一条按工具失败处理（`isError: true`），不静默跳过。
       */
      name: string;
      /** 原样交给工具的 `execute` —— 模型给的参数长什么样，这里就长什么样。 */
      args: Record<string, unknown>;
    }
  | { after_ms: number; type: 'agent_end'; reason: 'completed' | 'aborted' | 'error'; errorMessage?: string };

export type FixtureFile = { events: FixtureEvent[] };
