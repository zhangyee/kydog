import { ZOOM_SENSITIVITY } from './zoomSensitivity';

export function wheelZoomSensitivity(platform: string): number {
  return platform === 'win32' ? 0.0005 : ZOOM_SENSITIVITY;
}

export function wheelZoomFactor(deltaY: number, platform: string): number {
  return 1 - deltaY * wheelZoomSensitivity(platform);
}

export function canStartPan(
  platform: string, pointerType: string, button: number, tool: string,
  scrollWidth: number, clientWidth: number, zoomed: boolean, interactiveTarget: boolean,
): boolean {
  return platform === 'win32' && pointerType === 'mouse' && button === 0 &&
    tool === 'select' && (scrollWidth > clientWidth || zoomed) && !interactiveTarget;
}
