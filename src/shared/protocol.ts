import type {
  BootstrapState, Project, Thread, Message, FsNode, SettingsFile,
} from './types';
import type { SerializedError } from './errors';

export type RpcCall =
  | { method: 'app.bootstrap'; args: undefined; result: BootstrapState }
  | { method: 'settings.get'; args: undefined; result: SettingsFile }
  | { method: 'settings.update'; args: Partial<SettingsFile>; result: SettingsFile }
  | { method: 'project.open'; args: undefined; result: Project }
  | { method: 'project.list'; args: undefined; result: Project[] }
  | { method: 'project.close'; args: { projectPath: string }; result: void }
  | { method: 'project.readDir'; args: { path: string }; result: FsNode[] }
  | { method: 'thread.create'; args: { projectPath: string; title?: string }; result: Thread }
  | { method: 'thread.list'; args: { projectPath: string }; result: Thread[] }
  | { method: 'thread.delete'; args: { threadId: string }; result: void }
  | { method: 'thread.rename'; args: { threadId: string; title: string }; result: void }
  | { method: 'thread.loadHistory'; args: { threadId: string }; result: Message[] }
  | { method: 'thread.send'; args: { threadId: string; content: string }; result: { runId: string } }
  | { method: 'thread.abort'; args: { threadId: string }; result: void };

export type RpcMethod = RpcCall['method'];
export type RpcArgs<M extends RpcMethod> = Extract<RpcCall, { method: M }>['args'];
export type RpcResult<M extends RpcMethod> = Extract<RpcCall, { method: M }>['result'];

export type RpcResponse<M extends RpcMethod> =
  | { ok: true; data: RpcResult<M> }
  | { ok: false; error: SerializedError };

export type RuntimeEvent =
  | { topic: 'run.started'; payload: { threadId: string; runId: string } }
  | { topic: 'run.message_delta'; payload: { threadId: string; runId: string; messageId: string; delta: string } }
  | { topic: 'run.tool_call_start'; payload: { threadId: string; runId: string; toolCallId: string; name: string; command?: string } }
  | { topic: 'run.tool_call_chunk'; payload: { threadId: string; runId: string; toolCallId: string; stream: 'stdout' | 'stderr'; chunk: string } }
  | { topic: 'run.tool_call_end'; payload: { threadId: string; runId: string; toolCallId: string; status: 'ok' | 'failed'; exitCode?: number } }
  | { topic: 'run.message_end'; payload: { threadId: string; runId: string; messageId: string } }
  | { topic: 'run.ended'; payload: { threadId: string; runId: string; reason: 'completed' | 'aborted' | 'error'; errorMessage?: string } };

export type EventTopic = RuntimeEvent['topic'];
export type EventPayload<T extends EventTopic> = Extract<RuntimeEvent, { topic: T }>['payload'];

export const RPC_CHANNEL = 'kydog:rpc' as const;
export const EVENT_CHANNEL = 'kydog:event' as const;
