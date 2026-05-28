#!/usr/bin/env bash
# 从 assets/kydog.svg 生成应用图标（icns / ico / png）。
# 依赖：qlmanage、sips、iconutil（macOS 自带），png-to-ico（npx 临时拉取）。
# 用法：bash scripts/build-icons.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/kydog.svg"
OUT="$ROOT/assets/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT"

# 1. 收紧 viewBox 让 logo 占画布 ~60%，sepia paper 暖黄底 + 方格纸网格线
#    底色 #F4EADA = oklch(0.94 0.024 78)，sepia 主题，比 vellum 更黄更"老纸"
#    网格 24x24 tile，stroke 1.8 + alpha 0.45 + 饱和棕，确保 dock 32-48px 下也可见
#    面部矩形 fill:none → fill:paper，让脸内部不透格子（更像图标）
#    macOS Tahoe 自动按 squircle 蒙版裁掉四角；Windows 任务栏直接显方形
BG_COLOR="#F4EADA"
GRID_COLOR="rgba(110,75,40,0.45)"
TIGHT="$TMP/kydog-tight.svg"
python3 - "$SRC" "$TIGHT" "$BG_COLOR" "$GRID_COLOR" <<'PY'
import re, sys
src_path, dst_path, bg, grid = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
content = open(src_path).read()
content = content.replace(
    'viewBox="0 0 169.33333 169.33333"',
    'viewBox="0 -9 170 170"'
)
inject = f'''    <pattern id="paperGrid" patternUnits="userSpaceOnUse" width="24" height="24">
      <path d="M 24 0 L 0 0 L 0 24" stroke="{grid}" stroke-width="1.8" fill="none"/>
    </pattern>
  </defs>
  <rect x="0" y="-9" width="170" height="170" fill="{bg}"/>
  <rect x="0" y="-9" width="170" height="170" fill="url(#paperGrid)"/>'''
content = content.replace('</defs>', inject)
# 原 SVG 里属性顺序是 style 在前 / id 在后，要按这个顺序写 regex
content = re.sub(
    r'(<rect[^>]*?style="[^"]*?)fill:none([^"]*"[^>]*?\bid="rect8")',
    rf'\1fill:{bg}\2',
    content,
)
open(dst_path, 'w').write(content)
PY

# 2. 渲染 1024 PNG（qlmanage 输出文件名固定为 <basename>.png）
qlmanage -t -s 1024 -o "$TMP" "$TIGHT" >/dev/null 2>&1
PNG1024="$TMP/kydog-tight.svg.png"
[ -f "$PNG1024" ] || { echo "qlmanage 渲染失败" >&2; exit 1; }

# 3. 下采样到各尺寸（sips Lanczos 比让 qlmanage 在小尺寸重渲染更稳）
ICONSET="$TMP/kydog.iconset"
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
  sips -z "$size" "$size" "$PNG1024" --out "$ICONSET/_$size.png" >/dev/null
done
cp "$PNG1024" "$ICONSET/_1024.png"

# 4. 按 iconutil 约定重命名（含 @2x 副本）
cp "$ICONSET/_16.png"   "$ICONSET/icon_16x16.png"
cp "$ICONSET/_32.png"   "$ICONSET/icon_16x16@2x.png"
cp "$ICONSET/_32.png"   "$ICONSET/icon_32x32.png"
cp "$ICONSET/_64.png"   "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/_128.png"  "$ICONSET/icon_128x128.png"
cp "$ICONSET/_256.png"  "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/_256.png"  "$ICONSET/icon_256x256.png"
cp "$ICONSET/_512.png"  "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/_512.png"  "$ICONSET/icon_512x512.png"
cp "$ICONSET/_1024.png" "$ICONSET/icon_512x512@2x.png"
rm "$ICONSET"/_*.png

# 5. macOS .icns
iconutil -c icns -o "$OUT/icon.icns" "$ICONSET"

# 6. 通用 PNG（Linux maker + 开发模式 BrowserWindow icon）
cp "$PNG1024" "$OUT/icon.png"

# 7. Windows .ico（用 npx png-to-ico 临时打包，多分辨率）
ICO_TMP="$TMP/ico-inputs"
mkdir -p "$ICO_TMP"
for size in 16 32 48 64 128 256; do
  sips -z "$size" "$size" "$PNG1024" --out "$ICO_TMP/$size.png" >/dev/null
done
npx --yes png-to-ico \
  "$ICO_TMP/16.png" "$ICO_TMP/32.png" "$ICO_TMP/48.png" \
  "$ICO_TMP/64.png" "$ICO_TMP/128.png" "$ICO_TMP/256.png" \
  > "$OUT/icon.ico"

echo "Done:"
ls -lh "$OUT"
