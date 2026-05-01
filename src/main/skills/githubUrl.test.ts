import { describe, it, expect } from 'vitest';
import { parseGithubUrl } from './githubUrl';

describe('parseGithubUrl', () => {
  it('plain repo URL → ref=HEAD subPath=""', () => {
    const r = parseGithubUrl('https://github.com/owner/repo');
    expect(r).toEqual({
      owner: 'owner', repo: 'repo', ref: 'HEAD', subPath: '',
      codeloadUrl: 'https://codeload.github.com/owner/repo/tar.gz/HEAD',
    });
  });

  it('tree without path', () => {
    const r = parseGithubUrl('https://github.com/owner/repo/tree/main');
    expect(r.ref).toBe('main');
    expect(r.subPath).toBe('');
    expect(r.codeloadUrl).toBe('https://codeload.github.com/owner/repo/tar.gz/main');
  });

  it('tree with single-segment ref + path', () => {
    const r = parseGithubUrl('https://github.com/anthropics/skills/tree/main/skills');
    expect(r.ref).toBe('main');
    expect(r.subPath).toBe('skills');
  });

  it('tree with deep path', () => {
    const r = parseGithubUrl('https://github.com/owner/repo/tree/v1/sub/path');
    expect(r.ref).toBe('v1');
    expect(r.subPath).toBe('sub/path');
  });

  it('codeload URL passes through', () => {
    const r = parseGithubUrl('https://codeload.github.com/owner/repo/tar.gz/feat/foo');
    expect(r).toEqual({
      owner: 'owner', repo: 'repo', ref: 'feat/foo', subPath: '',
      codeloadUrl: 'https://codeload.github.com/owner/repo/tar.gz/feat/foo',
    });
  });

  it('rejects non-GitHub URL', () => {
    expect(() => parseGithubUrl('https://example.com/x.zip')).toThrow(/skill\.unsupported_archive|github/);
  });

  it('rejects http (no https)', () => {
    expect(() => parseGithubUrl('http://github.com/owner/repo')).toThrow();
  });
});
