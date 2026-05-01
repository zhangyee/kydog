import { KydogError } from '../../shared/errors';

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
  ref: string;       // 'HEAD' if not specified; may include '/' only when input was a codeload URL
  subPath: string;   // '' when not specified
  codeloadUrl: string;
}

const GH_TREE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/;
const CODELOAD = /^https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+?)\/tar\.gz\/(.+)$/;

export function parseGithubUrl(url: string): ParsedGithubUrl {
  const cl = CODELOAD.exec(url);
  if (cl) {
    const [, owner, repo, ref] = cl;
    return { owner, repo, ref, subPath: '', codeloadUrl: url };
  }
  const m = GH_TREE.exec(url);
  if (!m) {
    throw new KydogError('skill.unsupported_archive', '目前仅支持 github.com URL');
  }
  const [, owner, repo, ref, subPath] = m;
  const refResolved = ref ?? 'HEAD';
  const codeloadUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${refResolved}`;
  return { owner, repo, ref: refResolved, subPath: subPath ?? '', codeloadUrl };
}
