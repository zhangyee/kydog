import { BEACON_PATH, FORGET_PATH, TELEMETRY_ORIGIN, type BeaconPayload } from '../../shared/telemetryContract';
import { REQUEST_TIMEOUT_MS } from './constants';

export type { BeaconPayload };

export type BeaconOutcome =
  | { kind: 'sent' }
  | { kind: 'failed'; reason: string };

export type ForgetOutcome =
  | { kind: 'confirmed' }
  | { kind: 'failed'; reason: string };

type FetchFn = typeof fetch;

async function post(url: string, body: unknown, doFetch: FetchFn): Promise<{ status: number } | { err: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { status: res.status };
  } catch (err) {
    return { err: String((err as Error)?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** `doFetch` 是通用的网络注入点（测试靠它模拟各种响应），不是纯测试接缝。
 *  端点 origin 不可注入 —— 没有任何运行时开关能改它。 */
export async function sendBeacon(p: BeaconPayload, doFetch: FetchFn = fetch): Promise<BeaconOutcome> {
  const r = await post(`${TELEMETRY_ORIGIN}${BEACON_PATH}`, p, doFetch);
  if ('err' in r) return { kind: 'failed', reason: r.err };
  // 只有 204 算送达。契约里 204 是写入提交成功的确认，其余一律不可信
  return r.status === 204 ? { kind: 'sent' } : { kind: 'failed', reason: `HTTP ${r.status}` };
}

/** 204 是耐久确认（服务端事务已提交），客户端仅凭它才允许丢弃本地 ID。 */
export async function forget(id: string, doFetch: FetchFn = fetch): Promise<ForgetOutcome> {
  const r = await post(`${TELEMETRY_ORIGIN}${FORGET_PATH}`, { id }, doFetch);
  if ('err' in r) return { kind: 'failed', reason: r.err };
  return r.status === 204 ? { kind: 'confirmed' } : { kind: 'failed', reason: `HTTP ${r.status}` };
}
