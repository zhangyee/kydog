import type { AssistantBlock } from '../../../shared/types';

export type ProcessBlock =
  | Extract<AssistantBlock, { kind: 'thinking' }>
  | Extract<AssistantBlock, { kind: 'tool_call' }>;

export type Group =
  | { kind: 'text'; block: Extract<AssistantBlock, { kind: 'text' }> }
  | { kind: 'process'; blocks: ProcessBlock[] };

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
    } else {
      buf.push(b);
    }
  }
  flush();
  return out;
}
