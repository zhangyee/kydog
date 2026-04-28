import { BrowserWindow } from 'electron';
import { EVENT_CHANNEL, type EventTopic, type EventPayload } from '../../shared/protocol';

export const broadcaster = {
  emit<T extends EventTopic>(topic: T, payload: EventPayload<T>): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, { topic, payload });
    }
  },
};
