import { BrowserWindow } from 'electron';
import { EVENT_CHANNEL, type EventTopic, type EventPayload } from '../../shared/protocol';
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
