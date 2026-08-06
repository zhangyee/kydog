import { it, expect } from 'vitest';
import * as C from './telemetryContract';

// 改这个快照 = 与服务端漂开，或打断尚未升级的旧客户端。
// 要改形状请两侧同时加 /v2，别改 /v1。
it('/v1 契约已冻结', () => {
  expect({
    beacon: C.BEACON_PATH,
    forget: C.FORGET_PATH,
    maxBody: C.MAX_BODY_BYTES,
    maxVersion: C.MAX_VERSION_LEN,
    platforms: [...C.PLATFORMS],
    arches: [...C.ARCHES],
    uuid: C.UUID_V4_RE,
    semver: C.SEMVER_RE,
  }).toEqual({
    beacon: '/v1/beacon',
    forget: '/v1/forget',
    maxBody: 512,
    maxVersion: 32,
    platforms: ['darwin', 'win32'],
    arches: ['x64', 'arm64'],
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    semver: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  });
});
