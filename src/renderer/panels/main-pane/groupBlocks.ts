import type { AskBlock, AssistantBlock } from '../../../shared/types';

export type ProcessBlock =
  | Extract<AssistantBlock, { kind: 'thinking' }>
  | Extract<AssistantBlock, { kind: 'tool_call' }>;

export type Group =
  | { kind: 'text'; block: Extract<AssistantBlock, { kind: 'text' }> }
  | { kind: 'process'; blocks: ProcessBlock[] }
  | { kind: 'ask'; block: AskBlock };

export function groupBlocks(blocks: AssistantBlock[]): Group[] {
  const out: Group[] = [];
  let buf: ProcessBlock[] = [];
  const flush = () => {
    if (buf.length) {
      out.push({ kind: 'process', blocks: buf });
      buf = [];
    }
  };
  for (const b of blocks) {
    if (b.kind === 'text') {
      flush();
      out.push({ kind: 'text', block: b });
    } else if (b.kind === 'ask') {
      // 问答是一张整幅卡片，不属于工具/思考那条过程流。
      flush();
      out.push({ kind: 'ask', block: b });
    } else {
      buf.push(b);
    }
  }
  flush();
  return out;
}
