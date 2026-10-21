import { describe, expect, it } from 'vitest';
import { extractBody } from './extractBody';

const sourceId = 'source-1';
const finalUrl = 'https://docs.example/v2/guide';
const bytes = (text: string) => new TextEncoder().encode(text);

describe('extractBody', () => {
  it('extracts semantic HTML passages, code, title, and absolute links without navigation text', async () => {
    const html = `<html><head><title>Version 2 Guide</title></head><body>
      <nav>Site menu should not appear</nav><main><h1>Version 2 Guide</h1>
      <p>Version 2 requires HTTPS. See <a href="./migration">migration guide</a>.</p>
      <h2>Example</h2><pre><code>fetch('https://example.org/v2')</code></pre></main>
      <script>window.location='https://bad.example'</script></body></html>`;
    const body = await extractBody({ bytes: bytes(html), contentType: 'text/html', finalUrl, sourceId });
    expect(body.status).toBe('readable');
    expect(body.title).toBe('Version 2 Guide');
    expect(body.completeness).toBe('complete');
    expect(body.passages.map((p) => p.passageId)).toEqual([
      `${sourceId}:p1`, `${sourceId}:p2`, `${sourceId}:p3`, `${sourceId}:p4`,
    ]);
    const text = body.passages.map((p) => p.text).join('\n');
    expect(text).toContain('Version 2 requires HTTPS');
    expect(text).toContain('https://docs.example/v2/migration');
    expect(text).toContain("fetch('https://example.org/v2')");
    expect(text).not.toContain('Site menu should not appear');
    expect(text).not.toContain('bad.example');
    expect(body.passages.at(-1)?.heading).toBe('Example');
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the declared HTTP favicon as resolved page metadata', async () => {
    const html = '<html><head><link rel="shortcut icon" href="../assets/site.png"></head>' +
      '<body><main><h1>Guide</h1><p>Body</p></main></body></html>';
    const body = await extractBody({ bytes: bytes(html), contentType: 'text/html', finalUrl, sourceId });
    expect(body.siteIconUrl).toBe('https://docs.example/assets/site.png');
  });

  it('does not expose data, javascript, or malformed favicon targets', async () => {
    for (const href of ['data:image/png;base64,AA==', 'javascript:alert(1)', 'http://[']) {
      const html = `<html><head><link rel="icon" href="${href}"></head>` +
        '<body><main><h1>Guide</h1><p>Body</p></main></body></html>';
      const body = await extractBody({ bytes: bytes(html), contentType: 'text/html', finalUrl, sourceId });
      expect(body.siteIconUrl).toBeUndefined();
    }
  });

  it('keeps plain text lines and marks explicitly truncated input incomplete', async () => {
    const source = bytes('first line\nsecond line\n');
    const complete = await extractBody({ bytes: source, contentType: 'text/plain; charset=utf-8', finalUrl, sourceId });
    const truncated = await extractBody({ bytes: source, contentType: 'text/plain', finalUrl, sourceId,
      truncated: true });
    expect(complete.passages.map((p) => p.text)).toEqual(['first line', 'second line']);
    expect(complete.completeness).toBe('complete');
    expect(truncated.completeness).toBe('truncated');
    expect(truncated.status).toBe('readable');
  });

  it('rejects PDF bytes even when the server labels them HTML', async () => {
    const body = await extractBody({ bytes: bytes('%PDF-1.7\nopaque'), contentType: 'text/html', finalUrl, sourceId });
    expect(body.status).toBe('unsupported_media');
    expect(body.passages).toEqual([]);
    expect(body.reason).toBe('pdf_not_supported');
  });

  it('rejects media outside HTML and plain text', async () => {
    const body = await extractBody({ bytes: bytes('# Document'), contentType: 'text/markdown', finalUrl, sourceId });
    expect(body.status).toBe('unsupported_media');
    expect(body.passages).toEqual([]);
  });

  it('treats an explicit verification widget as needs_browser rather than irrelevant content', async () => {
    const html = '<html><body><main><h1>Verify</h1><form><input name="captcha"></form></main></body></html>';
    const body = await extractBody({ bytes: bytes(html), contentType: 'text/html', finalUrl, sourceId });
    expect(body.status).toBe('needs_browser');
    expect(body.passages).toEqual([]);
  });

  it('leaves text-only verification semantics to extraction instead of guessing from a heading', async () => {
    const html = '<html><body><main><h1>Verify you are human</h1><p>Complete the security check to continue.</p></main></body></html>';
    const body = await extractBody({ bytes: bytes(html), contentType: 'text/html', finalUrl, sourceId });
    expect(body.status).toBe('readable');
    expect(body.passages.map((passage) => passage.text).join(' ')).toContain('Complete the security check');
    const article = await extractBody({ bytes: bytes('<main><h1>Verify you are human</h1><p>This article explains CAPTCHA design.</p></main>'),
      contentType: 'text/html', finalUrl, sourceId });
    expect(article.status).toBe('readable');
  });

  it('does not invent article content for an empty or script-only page', async () => {
    const html = '<html><body><script>location.href="/next"</script></body></html>';
    const body = await extractBody({ bytes: bytes(html), contentType: 'text/html', finalUrl, sourceId });
    expect(body.status).toBe('needs_browser');
    expect(body.passages).toEqual([]);
  });
});
