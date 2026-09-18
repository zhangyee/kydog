import { session } from 'electron';
import type { OnBeforeRequestListenerDetails, OnCompletedListenerDetails, OnErrorOccurredListenerDetails } from 'electron';
import { BROWSER_PARTITION } from './partition';
import { logger } from '../log';

/**
 * `session.webRequest` 的单一分发点。
 *
 * **每种事件、每个 session 只能挂一个监听器。** 签名是
 * `onBeforeRequest(listener | null)`（`electron.d.ts:18931`）—— 是「设置」不是
 * 「添加」，第二个调用方一挂就把第一个顶掉，**而且不报错**。所以凡是要观测
 * `webRequest` 的人一律走这里订阅，不许自己去挂。
 *
 * **订阅者是观测者，没有改判的口子。** 多个订阅者各自 `cancel` / `redirectURL`
 * 根本无法合并（谁赢？两个 redirect 去哪？），所以这里连让它们表态的机会都不给：
 * 派发完一律 `callback({})` 放行。要拦截得另外设计。
 *
 * **URL 闸不在这条路上，也别挪过来**（裁决 1）：它挂在
 * `wc.on('will-navigate' / 'will-redirect' / 'will-frame-navigate')` 上（见
 * `browserService.guardNav`），那里能 `preventDefault()` 当场 CANCEL、并同步喂
 * `NavigationTracker.onBlocked` —— 两样在这里都做不到。而且
 * `OnBeforeRequestListenerDetails.resourceType` 含 `webSocket / image / script /
 * xhr / font / media`（`electron.d.ts:21944`），把「拒一切非 http/https」的判据
 * 挪过来会把页面自己的 `wss://` 连接一并拒掉。
 *
 * 生产订阅者：`onBeforeRequest` 是登录观测（`isSamlAssertionPost` 要的 `url` / `method` /
 * `uploadData` 全在 details 里）；`onCompleted` / `onErrorOccurred` 是 `browserService` 的请求记录
 * （spec 2026-09-17-browser-request-signal-design）——这两种事件没有 callback，本来就只能观测。
 */

/** 订阅者拿到的就是 Electron 原样的那份 details —— 不投影、不裁剪。 */
export type BeforeRequestSubscriber = (details: OnBeforeRequestListenerDetails) => void;

/** 退订。**幂等**：调第二次不会波及后来的订阅者。 */
export type Unsubscribe = () => void;

export type CompletedSubscriber = (details: OnCompletedListenerDetails) => void;
export type ErrorOccurredSubscriber = (details: OnErrorOccurredListenerDetails) => void;

export type WebRequestHub = {
  onBeforeRequest(fn: BeforeRequestSubscriber): Unsubscribe;
  onCompleted(fn: CompletedSubscriber): Unsubscribe;
  onErrorOccurred(fn: ErrorOccurredSubscriber): Unsubscribe;
};

/**
 * `session.webRequest` 里我们用到的那几个方法。只声明用得上的，
 * 免得替身要去实现 `onHeadersReceived` 一整族才编译得过。
 */
export type WebRequestPort = {
  onBeforeRequest(
    listener:
      | ((details: OnBeforeRequestListenerDetails, callback: (response: { cancel?: boolean }) => void) => void)
      | null,
  ): void;
  onCompleted(listener: ((details: OnCompletedListenerDetails) => void) | null): void;
  onErrorOccurred(listener: ((details: OnErrorOccurredListenerDetails) => void) | null): void;
};

/**
 * 一种「只观测、不回调」的事件：多个订阅者共用底层那一个监听器，懒挂懒摘，退订幂等，
 * 一个订阅者抛了不影响别人 —— 与 `onBeforeRequest` 同一套规矩，只是没有放行这一步。
 */
function observerChannel<D>(
  name: string,
  set: (listener: ((details: D) => void) | null) => void,
): (fn: (details: D) => void) => Unsubscribe {
  const subs = new Set<(details: D) => void>();
  let attached = false;
  const dispatch = (details: D): void => {
    for (const fn of [...subs]) {
      try {
        fn(details);
      } catch (err) {
        // 日志里只留错误本身：details.url 的 userinfo 里可能带凭据。
        logger.warn('browser.webRequest', `${name} 订阅者抛了异常`, { err: String(err) });
      }
    }
  };
  const sync = (): void => {
    const want = subs.size > 0;
    if (want === attached) return;
    attached = want;
    set(want ? dispatch : null);
  };
  return (fn) => {
    subs.add(fn);
    sync();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      subs.delete(fn);
      sync();
    };
  };
}

export function createWebRequestHub(wr: WebRequestPort): WebRequestHub {
  const subs = new Set<BeforeRequestSubscriber>();
  let attached = false;

  const dispatch = (
    details: OnBeforeRequestListenerDetails,
    callback: (response: { cancel?: boolean }) => void,
  ): void => {
    try {
      // 迭代副本：订阅者在自己的回调里退订（登录观测看见断言回传就拆自己）是
      // 正常路径，直接迭代 Set 会让**同一次派发**里排在它后面的订阅者被跳过。
      for (const fn of [...subs]) {
        try {
          fn(details);
        } catch (err) {
          // **一个订阅者炸了不能让别人失聪，也不能让这条请求挂住。**
          // 日志里只留错误本身：`details.url` 的 userinfo 里可能带凭据
          // （`https://svc:密码@host/`），与 browserService 那四处同一条规矩。
          logger.warn('browser.webRequest', 'onBeforeRequest 订阅者抛了异常', { err: String(err) });
        }
      }
    } finally {
      // **必须调，且只调一次。** 不调那条请求不是失败、不是报错，是永远挂在那里。
      // 放在 finally 里：上面万一有非订阅者抛出的东西逃出来，请求也已经放行了。
      callback({});
    }
  };

  const sync = (): void => {
    const want = subs.size > 0;
    if (want === attached) return;   // 懒挂懒摘：没人订阅时不占着那个唯一的名额
    attached = want;
    wr.onBeforeRequest(want ? dispatch : null);
  };

  const onCompleted = observerChannel<OnCompletedListenerDetails>('onCompleted', (l) => wr.onCompleted(l));
  const onErrorOccurred = observerChannel<OnErrorOccurredListenerDetails>('onErrorOccurred', (l) => wr.onErrorOccurred(l));

  return {
    onCompleted,
    onErrorOccurred,
    onBeforeRequest(fn: BeforeRequestSubscriber): Unsubscribe {
      subs.add(fn);
      sync();
      let done = false;
      return () => {
        // `done` 这道闸不是多余的：同一个 fn 只在 Set 里存一份，第二次
        // `off()` 若照删不误，删掉的就是**后来那个同名订阅者**。
        if (done) return;
        done = true;
        subs.delete(fn);
        sync();
      };
    },
  };
}

let shared: WebRequestHub | null = null;

/**
 * 浏览器那个持久分区上的**唯一**一个 hub。
 *
 * 「Task 7 不必自己去挂 `session.webRequest`」的全部保障就是这一句：各自
 * `createWebRequestHub(session.fromPartition(...).webRequest)` 的话，两个 hub
 * 各挂各的，后建的顶掉先建的 —— 与谁都不用 hub 是同一个结局，且不报错。
 *
 * 惰性：`session.fromPartition` 要在 app ready 之后才能调，而本模块在
 * 主进程装配期就被 import。
 */
export function browserWebRequestHub(): WebRequestHub {
  shared ??= createWebRequestHub(session.fromPartition(BROWSER_PARTITION).webRequest);
  return shared;
}

/** 用例专用：把上面那个进程级单例清掉，免得用例之间互相看见对方的订阅。 */
export function _resetSharedHubForTest(): void {
  shared = null;
}
