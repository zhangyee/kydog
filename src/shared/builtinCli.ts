export const BUILTIN_CLIS: ReadonlySet<string> = new Set([
  'fastpaper',
]);

export function commandHead(command?: string): string | null {
  const token = command?.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : null;
}

export function isBuiltinCliCommand(command?: string): boolean {
  const head = commandHead(command);
  return head !== null && BUILTIN_CLIS.has(head);
}
