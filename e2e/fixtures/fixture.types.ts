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
  | { after_ms: number; type: 'agent_end'; reason: 'completed' | 'aborted' | 'error'; errorMessage?: string };

export type FixtureFile = { events: FixtureEvent[] };
