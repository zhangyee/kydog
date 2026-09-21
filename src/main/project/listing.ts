/**
 * 文件树列表里出现哪些条目。`project.readDir` 按它过滤，`fileWatcher` 也按它判断
 * 「这条事件动没动到列表」—— 两边必须是同一个谓词：列表里本来就不显示的条目
 * （`.paper.pdf.json` 这类边车，翻译时一秒写好几次）变了，没理由让渲染层重读一遍目录。
 */
export function isListedName(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules';
}
