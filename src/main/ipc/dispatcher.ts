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

export function installDispatcher(): void {
  ipcMain.handle(RPC_CHANNEL, async (evt, payload: { method: RpcMethod; args: unknown }): Promise<RpcResponse<RpcMethod>> => {
    const { method, args } = payload;
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
