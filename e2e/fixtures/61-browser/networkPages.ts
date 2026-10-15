/** Generic channel evidence; no X wire semantics or private capture bytes. */
export const NETWORK_BODY = 'Network capture: 汉字 🙂\nsecond line\n';
export function networkPage(name: string): string {
  if(name==='iframe')return `<!doctype html><meta charset="utf-8"><iframe src="/frame/iframe"></iframe><script src="/hold/iframe"></script>`;
  return `<!doctype html><meta charset="utf-8"><script>fetch('/body/${name}').then(r=>r.text()).then(()=>document.documentElement.dataset.fetched='yes')</script><script src="/hold/${name}"></script><p>Network capture ${name}</p>`;
}
