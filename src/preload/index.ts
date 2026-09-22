import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  RPC_CHANNEL, EVENT_CHANNEL,
  type RpcMethod, type RpcArgs, type RpcResult, type RpcResponse,
  type EventTopic, type EventPayload,
} from '../shared/protocol';

const bridge = {
  platform: process.platform,
  async invoke<M extends RpcMethod>(
    method: M,
    ...args: RpcArgs<M> extends undefined ? [] : [RpcArgs<M>]
  ): Promise<RpcResult<M>> {
    const r = await ipcRenderer.invoke(RPC_CHANNEL, { method, args: args[0] }) as RpcResponse<M>;
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
  /**
   * 拖入 / 粘贴 / 回形针拿到的 File 在磁盘上的路径；**空串 = 磁盘上没有这个文件**（例如粘贴的截图）。
   * Electron 32 起 `File.path` 已移除，只能走 webUtils（spec §3.2）。
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('kydog', bridge);

export type KydogBridge = typeof bridge;
