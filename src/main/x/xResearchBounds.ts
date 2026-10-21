// 请求边界（旧工具同一处前置校验）：TypeBox 只挡得住 query 的 4096 units，挡不住构造出来的
// 公开搜索 URL（4096 个汉字约 36 KB）。read 的 target 更是只校验非空。两者都必须在碰浏览器之前拒。
//
// 两个调用点，同一份判据：
//  - 工具的 `submit`（`../agent/xResearchTools`）：模型当场拿到可行动的拒绝。只靠 runner 的话，
//    拒绝发生在一份**已经入队**的提交里，会被 `run` 的 catch 吞成一条 `interrupted` —— 模型看到
//    的是泛化失败，而不是「把 query 缩短或拆分」。
//  - runner（`./xResearchRunner`）：`browserFor` 之前的最后一道，一行都不许导航。
import { X_DOM_MAX_QUERY_UNITS, X_DOM_MAX_STRING_UNITS } from './xDomSource';
import { xSearchUrl } from './xResearchSearch';
import type { XResearchWorkRequest } from './xResearchTaskService';

export function assertXRequestWithinBounds(work: XResearchWorkRequest): void {
  if ('search' in work) {
    for (const row of work.search.queries) {
      if (row.query.length > X_DOM_MAX_QUERY_UNITS || xSearchUrl(row).length > X_DOM_MAX_STRING_UNITS) {
        throw new Error('x_research: query exceeds the validated request bounds; shorten or split the query');
      }
    }
    return;
  }
  for (const target of work.read.targets) {
    if ((target.url ?? target.postId).length > X_DOM_MAX_STRING_UNITS) {
      throw new Error('x_research: target exceeds the validated request bounds; use a shorter actually observed permalink');
    }
  }
}
