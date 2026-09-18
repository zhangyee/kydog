/**
 * 内置浏览器自己的 cookie 罐子，与 KyDog 主窗口完全隔开。
 * 持久化是刻意的：用户登录一次机构，之后 agent 都能用同一个会话。
 *
 * 单独成一个模块只为一件事：`webRequestHub` 必须拿到**同一个** session，
 * 而它不该为了一个字符串把整个 `browserService`（连同 walker / pwRegistrar /
 * interact 三份 `?raw` 注入源）拖进自己的依赖图里。两边 import 同一个常量，
 * 「同一个 session」就是结构上的事实，不靠两处字面量碰巧一致。
 */
export const BROWSER_PARTITION = 'persist:kydog-browser';
