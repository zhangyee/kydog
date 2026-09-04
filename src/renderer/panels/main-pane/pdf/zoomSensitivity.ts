// 捏合缩放（ctrl+wheel）每单位 deltaY 对应的缩放系数，PdfFileTab 的 onWheel 用它把手势
// 转成新的 targetScale。单独抽出来（而不是留在 PdfFileTab.tsx 里当私有常量）：57 号 e2e 要
// 按同一条公式反推 deltaY 才能把捏合精确落在某个百分比，从组件文件 import 会把 react-pdf /
// pdf.js worker 那一整串副作用拖进 Playwright 的 node 上下文（同 pageLayout.ts 顶部关于
// PAGE_GAP 单独抽出来的理由一样）。之前 e2e 是照抄这个数字而不是 import，两处字面量分别改
// 一处就会悄悄对不上，且不会被任何检查发现。
export const ZOOM_SENSITIVITY = 0.0075;
