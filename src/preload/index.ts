import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  RPC_CHANNEL, EVENT_CHANNEL,
  type RpcMethod, type RpcArgs, type RpcResult, type RpcResponse,
  type EventTopic, type EventPayload,
} from '../shared/protocol';

const bridge = {
  async invoke<M extends RpcMethod>(method: M, args: RpcArgs<M>): Promise<RpcResult<M>> {
    const r = await ipcRenderer.invoke(RPC_CHANNEL, { method, args }) as RpcResponse<M>;
    if (!r.ok) {
      const e = new Error(r.error.message);
      (e as Error & { code?: string }).code = r.error.code;
      throw e;
    }
    return r.data;
  },
  on<T extends EventTopic>(topic: T, listener: (payload: EventPayload<T>) => void): () => void {
    const handler = (_evt: IpcRendererEvent, payload: { topic: EventTopic; payload: unknown }) => {
      if (payload.topic === topic) listener(payload.payload as EventPayload<T>);
    };
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.off(EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld('kydog', bridge);

export type KydogBridge = typeof bridge;
