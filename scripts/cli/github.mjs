// scripts/cli/github.mjs
// GitHub Releases API + 资产直链（Node fetch；不依赖 gh CLI）

const API = 'https://api.github.com';
const DL = 'https://github.com';

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
