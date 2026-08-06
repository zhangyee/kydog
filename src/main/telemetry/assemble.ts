import { app } from 'electron';
import { createTelemetryService, type TelemetryService, type TelemetrySettings } from './telemetryService';
import { telemetryAllowed, exactPlatform, exactArch, versionOk } from './gate';
import { sendBeacon, forget } from './transport';
import { settingsService } from '../settings/settingsService';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import type { TelemetryState, TelemetryStatus } from '../../shared/types';

// 单独一个装配模块而不是在 main.ts 里 export：handlers.ts 需要这个服务，而
// main.ts 又要 import handlers.ts 才能注册 —— 那是循环 import。与 update/assemble.ts 同形。
let service: TelemetryService | null = null;
let beaconAllowed = false;
let networkAllowed = false;

/** TelemetryStatus 的唯一装配点。IPC 的三个返回值与 telemetry.status 广播都走这里 ——
 *  两处各拼一份的话，加字段时必然漏掉一处，而漏掉的那处会是广播（没人手动点它）。 */
function statusOf(state: TelemetryState, installId: string | null): TelemetryStatus {
  return { state, installId, canBeacon: beaconAllowed, canReachNetwork: networkAllowed };
}

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
  networkAllowed = gateOk;

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
    // 与 update/assemble.ts 的 onStatusChange → broadcaster.emit 同形。
    // 这条广播是隐私面板唯一能知道「启动时那次删除重试兑现了」的途径。
    onChange: (s) => broadcaster.emit('telemetry.status', statusOf(s.state, s.installId)),
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

/** 供 IPC 返回给渲染层的当前状态。canBeacon 是闸门的**最终**结果（含版本与平台自检），
 *  不是裸的 telemetryAllowed() —— 那会让版本非法时 UI 显示开关可用、实际静默不报。 */
export function telemetryStatus(): TelemetryStatus {
  const svc = getTelemetryService();
  return statusOf(svc.state(), svc.currentId());
}
