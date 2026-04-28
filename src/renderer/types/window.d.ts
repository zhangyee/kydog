import type { KydogBridge } from '../../preload/index';

declare global {
  interface Window {
    kydog: KydogBridge;
  }
}

export {};
