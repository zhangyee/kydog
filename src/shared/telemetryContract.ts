/** 统计上报的 HTTP 契约。服务端仓库（kydog-telemetry）有一份逐字节相同的副本。
 *  两个仓库独立部署，共享 npm 包只会制造一个假的同步保证 —— 不如各存一份，
 *  由两侧的契约快照测试锁住同一组字面量。
 *
 *  与 protocol.ts 对称：那是 RPC 契约（主进程 ↔ 渲染层），这是 HTTP 契约（客户端 ↔ Worker）。
 *
 *  **一经发布即冻结。** 客户端随应用版本缓慢铺开，Worker 部署即时生效，
 *  改形状会打断尚未升级的旧客户端。要改就加 /v2。 */

export const TELEMETRY_ORIGIN = 'https://kydog-analytics.yeezhang.im';
export const BEACON_PATH = '/v1/beacon';
export const FORGET_PATH = '/v1/forget';

export const MAX_BODY_BYTES = 512;
export const MAX_VERSION_LEN = 32;

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const PLATFORMS = ['darwin', 'win32'] as const;
export const ARCHES = ['x64', 'arm64'] as const;

export type Platform = (typeof PLATFORMS)[number];
export type Arch = (typeof ARCHES)[number];

export type BeaconPayload = {
  id: string;
  platform: Platform;
  arch: Arch;
  version: string;
};

export type ForgetPayload = { id: string };
