import { app } from 'electron';
import { createTelemetryService, type TelemetryService, type TelemetrySettings } from './telemetryService';
import { telemetryAllowed, exactPlatform, exactArch, versionOk } from './assembly';
import { sendBeacon, forget } from './transport';
import { settingsService } from '../settings/settingsService';
import { logger } from '../log';

// 单独一个装配模块而不是在 main.ts 里 export：handlers.ts 需要这个服务，而
// main.ts 又要 import handlers.ts 才能注册 —— 那是循环 import。与 update/assemble.ts 同形。
let service: TelemetryService | null = null;
let beaconAllowed = false;

export function assembleTelemetry(initial: TelemetrySettings): void {
  // KYDOG_E2E 与 update/assemble.ts 用的是同一个变量名，别另起一个
  const gateOk = telemetryAllowed({ isPackaged: app.isPackaged, e2e: process.env.KYDOG_E2E });

  const appVersion = app.getVersion();
  const okVersion = versionOk(appVersion);
  if (!okVersion) logger.warn('telemetry', 'app version 不符合契约，本次运行不上报', { appVersion });

  const platform = exactPlatform(process.platform);
  const arch = exactArch(process.arch);
  if (!platform || !arch) {
    logger.warn('telemetry', '平台或架构不在契约枚举内，本次运行不上报', { platform: process.platform, arch: process.arch });
  }

  beaconAllowed = gateOk && okVersion && platform !== null && arch !== null;

  service = createTelemetryService({
    // 两道闸分开：版本非法 / 平台不在枚举内是这个构建的永久属性，发不了 beacon；
    // 但 forget 的 payload 只有 {id}，删除必须照常能走，否则用户永远冻在 deleting。
    canReachNetwork: gateOk,
    canBeacon: beaconAllowed,
    initial,
    save: (t) => settingsService.setTelemetry(t),
    forget,
    send: sendBeacon,
    appVersion,
    platform,
    arch,
  });

  // init() 里 ensureInstallId() 写盘可能失败。不接住会变成 unhandled rejection ——
  // 统计永远不该影响主进程存活。
  void service.init().catch((err) => {
    logger.warn('telemetry', 'init 失败，本次运行不上报', { err: String(err) });
  });
}

export function getTelemetryService(): TelemetryService {
  if (!service) throw new Error('telemetry 服务尚未装配');
  return service;
}

/** 闸门的**最终**结果（含版本与平台自检），即 canBeacon，供 IPC 返回给渲染层。
 *  不要用裸的 telemetryAllowed() —— 那会让版本非法时 UI 显示开关可用、实际静默不报。 */
export function telemetryGateOpen(): boolean {
  return beaconAllowed;
}
