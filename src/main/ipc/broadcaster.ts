import { BrowserWindow, type WebContents } from 'electron';
import { EVENT_CHANNEL, type EventTopic, type EventPayload, type RuntimeEvent } from '../../shared/protocol';
import { logger } from '../log';

export const broadcaster = {
  emit<T extends EventTopic>(topic: T, payload: EventPayload<T>): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(EVENT_CHANNEL, { topic, payload });
      } catch (err) {
        logger.warn('ipc.broadcast', 'send failed', { topic, err: String(err) });
      }
    }
  },
};

/**
 * 只发给某一个窗口的事件出口。
 *
 * 目前唯一的用途是 thread.loadHistory 的 journal 重放：那是**补一个窗口自己缺的课**，
 * 广播出去会让其它窗口把已经消费过的事件再吃一遍。整份事件走的仍是 EVENT_CHANNEL，
 * 与后续实时广播对同一个 webContents 是同一条通道、先进先出，所以重放与直播严格有序。
 */
export type EventSink = (event: RuntimeEvent) => void;

export function sinkFor(sender: WebContents): EventSink {
  return (event) => {
    if (sender.isDestroyed()) return;
    try {
      sender.send(EVENT_CHANNEL, event);
    } catch (err) {
      logger.warn('ipc.broadcast', 'replay send failed', { topic: event.topic, err: String(err) });
    }
  };
}
