// scripts/cli/github.mjs
// GitHub Releases API + 资产直链（Node fetch；不依赖 gh CLI）

const API = 'https://api.github.com';
const DL = 'https://github.com';
const RAW = 'https://raw.githubusercontent.com';

function authHeaders() {
  const tok = process.env.GITHUB_TOKEN;
  return tok ? { authorization: `Bearer ${tok}` } : {};
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', ...authHeaders() } });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const err = new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

export async function latestStableTag(repo) {
  const r = await getJson(`${API}/repos/${repo}/releases/latest`);
  if (!r.tag_name) throw new Error(`releases/latest for ${repo} missing tag_name`);
  return r.tag_name;
}

export function releaseAssetUrl(repo, tag, asset) {
  return `${DL}/${repo}/releases/download/${tag}/${asset}`;
}

export async function fetchShaForAsset(repo, tag, asset) {
  const url = releaseAssetUrl(repo, tag, asset) + '.sha256';
  let txt;
  try {
    txt = await getText(url);
  } catch (e) {
    if (e.status === 404) throw new Error(`no SHASUMS for ${asset} at ${tag}: upstream must publish <asset>.sha256 to be supported (got 404 on ${url})`);
    throw e;
  }
  // 单行 "<sha>  <filename>" 或单纯 "<sha>"
  const first = txt.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]+$/i.test(first)) {
    throw new Error(`unexpected sha256 file format at ${url}: ${txt.slice(0, 80)}`);
  }
  return first.toLowerCase();
}

export async function fetchDistManifest(repo, tag) {
  const url = releaseAssetUrl(repo, tag, 'dist-manifest.json');
  try {
    const txt = await getText(url);
    return JSON.parse(txt);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** 该 tag 下的整棵树（含目录项，由调用方按 type 过滤）；被截断则拒绝，避免漏文件被当成"上游删了" */
export async function fetchRepoTree(repo, tag) {
  const r = await getJson(`${API}/repos/${repo}/git/trees/${encodeURIComponent(tag)}?recursive=1`);
  if (r.truncated) {
    throw new Error(`tree for ${repo}@${tag} is truncated by GitHub; can't enumerate files reliably`);
  }
  return (r.tree ?? []).map((e) => ({ path: e.path, type: e.type, sha: e.sha }));
}

/** 取仓库单文件的原始字节（skill 里可能有图片等二进制，所以不走 getText） */
export async function fetchRepoFile(repo, tag, filePath) {
  const url = `${RAW}/${repo}/${encodeURIComponent(tag)}/${filePath}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
