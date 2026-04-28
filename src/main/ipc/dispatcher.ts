import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { RPC_CHANNEL, type RpcMethod, type RpcArgs, type RpcResult, type RpcResponse } from '../../shared/protocol';
import { logger } from '../log';
import { serializeError } from '../../shared/errors';

type Handler<M extends RpcMethod> = (args: RpcArgs<M>, evt: IpcMainInvokeEvent) => Promise<RpcResult<M>> | RpcResult<M>;
type HandlerMap = { [M in RpcMethod]?: Handler<M> };

const handlers: HandlerMap = {};

export function registerHandler<M extends RpcMethod>(method: M, handler: Handler<M>): void {
  handlers[method] = handler as HandlerMap[M];
}

export function _clearHandlersForTesting(): void {
  for (const key of Object.keys(handlers) as RpcMethod[]) delete handlers[key];
}

export function installDispatcher(): void {
  ipcMain.handle(RPC_CHANNEL, async (evt, raw): Promise<RpcResponse<RpcMethod>> => {
    if (!raw || typeof raw !== 'object' || typeof (raw as { method?: unknown }).method !== 'string') {
      logger.error('ipc', 'malformed payload', { raw: typeof raw });
      return { ok: false, error: { code: 'unknown', message: 'malformed RPC payload' } };
    }
    const { method, args } = raw as { method: RpcMethod; args: unknown };
    const handler = handlers[method] as Handler<RpcMethod> | undefined;
    if (!handler) {
      logger.error('ipc', 'no handler', { method });
      return { ok: false, error: { code: 'unknown', message: `no handler for ${method}` } };
    }
    try {
      const data = await handler(args as never, evt);
      return { ok: true, data };
    } catch (err) {
      logger.error('ipc', 'handler threw', { method, err: String(err) });
      return { ok: false, error: serializeError(err) };
    }
  });
}
