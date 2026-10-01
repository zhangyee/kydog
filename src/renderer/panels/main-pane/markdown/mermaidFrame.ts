import type { MermaidConfig } from 'mermaid';
import { auditMermaidSvg } from './mermaidSvgAudit';

/** Self-contained bootstrap, serialized into an opaque, scripts-only frame. */
function bootMermaidFrame(audit: (svg: string) => string) {
  window.addEventListener('message', async (event) => {
    if (event.source !== parent || !event.ports[0]) return;
    const port = event.ports[0];
    const { bundle, id, source, config } = event.data;
    let bundleUrl: string | undefined;
    try {
      bundleUrl = URL.createObjectURL(new Blob([bundle], { type: 'text/javascript' }));
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = bundleUrl!;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Mermaid runtime could not load'));
        document.head.append(script);
      });
      const mermaid = (window as unknown as { mermaid: {
        initialize(config: MermaidConfig): void;
        render(id: string, source: string): Promise<{ svg: string }>;
      } }).mermaid;
      mermaid.initialize(config);
      const result = await mermaid.render(id, source);
      port.postMessage({ svg: audit(result.svg) });
    } catch (error) {
      port.postMessage({ error: error instanceof Error ? error.message : 'Mermaid preview failed' });
    } finally {
      if (bundleUrl) URL.revokeObjectURL(bundleUrl);
      port.close();
    }
  }, { once: true });
}

/** Each render owns a realm: no shared Mermaid DB, document, or cross-block queue. */
export function renderMermaidFrame(bundle: string, id: string, source: string, config: MermaidConfig): Promise<{ svg: string }> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.className = 'kydog-mermaid-render-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Layout is required for Mermaid's SVG measurements; display:none is invalid.
    frame.style.cssText = 'position:fixed;left:-100000px;top:0;width:1024px;height:768px;visibility:hidden;pointer-events:none;border:0';
    const nonce = crypto.randomUUID();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}' blob:; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
    const channel = new MessageChannel();
    const clean = () => { channel.port1.close(); frame.remove(); };
    channel.port1.onmessage = (event: MessageEvent<{ svg?: string; error?: string }>) => {
      clean();
      if (typeof event.data.svg === 'string') resolve({ svg: event.data.svg });
      else reject(new Error(event.data.error ?? 'Mermaid frame failed'));
    };
    frame.onerror = () => { clean(); reject(new Error('Mermaid frame could not load')); };
    frame.onload = () => frame.contentWindow!.postMessage({ bundle, id, source, config }, '*', [channel.port2]);
    frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script nonce="${nonce}">(${bootMermaidFrame.toString()})(${auditMermaidSvg.toString()})</script></body></html>`;
    document.body.append(frame);
  });
}
