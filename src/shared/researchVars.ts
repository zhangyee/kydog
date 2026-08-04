import type { ResearchVarKind } from './types';

export type PresetResearchVar = {
  name: string;
  kind: ResearchVarKind;
  /** 页面上给人看的名字 */
  label: string;
  /** 受这个变量影响的 fastpaper 源 */
  sources: string;
  /** 填了能换来什么 */
  note: string;
};

/** 预设项元数据的唯一真相。存储层只装值，不装这里的任何字段。 */
export const PRESET_RESEARCH_VARS: readonly PresetResearchVar[] = [
  {
    name: 'NCBI_API_KEY',
    kind: 'key',
    label: 'NCBI',
    sources: 'pubmed、pmc',
    note: '限速从 3 req/s 提到 10 req/s',
  },
  {
    name: 'SEMANTIC_SCHOLAR_API_KEY',
    kind: 'key',
    label: 'Semantic Scholar',
    sources: 'semantic',
    note: '不填会被重度限流，实际不可用',
  },
  {
    name: 'OPENALEX_API_KEY',
    kind: 'key',
    label: 'OpenAlex',
    sources: 'openalex',
    note: '免费额度 ×10（2026-02 起按量计费）',
  },
  {
    name: 'CORE_API_KEY',
    kind: 'key',
    label: 'CORE',
    sources: 'core',
    note: '不填匿名请求基本被 429',
  },
  {
    name: 'UNPAYWALL_EMAIL',
    kind: 'email',
    label: 'Unpaywall 邮箱',
    sources: 'unpaywall',
    note: '必填。Unpaywall 用它追踪调用方，填假地址可能被封禁；这里只校验格式',
  },
  {
    name: 'FASTPAPER_EMAIL',
    kind: 'email',
    label: '联系邮箱',
    sources: 'crossref、openalex、pubmed、pmc',
    note: 'crossref 用它进 polite pool',
  },
];

export const PRESET_RESEARCH_VAR_NAMES: ReadonlySet<string> = new Set(
  PRESET_RESEARCH_VARS.map((v) => v.name),
);
