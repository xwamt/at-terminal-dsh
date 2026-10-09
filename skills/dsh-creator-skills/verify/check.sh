#!/bin/bash
# 校验 dsh-creator-skills/skills 是否与本机 DeepSeek Harness 运行时一致
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
ASAR="$APP/Contents/Resources/app.asar"
PREFIX="dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/"
NODE="${NODE_BIN:-$(command -v node)}"

[ -f "$ASAR" ] || { echo "找不到 $ASAR"; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "app version : $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo '?')"
echo "asar        : $ASAR"
"$NODE" "$HERE/extract-asar.js" "$ASAR" "$PREFIX" "$TMP/runtime" >/dev/null

fail=0; n=0
while IFS= read -r f; do
  rel="${f#"$TMP"/runtime/}"; n=$((n+1))
  a="$(shasum -a 256 "$f" | cut -d' ' -f1)"
  b="$(shasum -a 256 "$ROOT/skills/$rel" 2>/dev/null | cut -d' ' -f1 || true)"
  if [ -z "$b" ]; then echo "  MISSING   $rel"; fail=1
  elif [ "$a" = "$b" ]; then echo "  IDENTICAL $rel"
  else echo "  DIFF      $rel"; fail=1; fi
done < <(find "$TMP/runtime" -type f | sort)

echo
if [ $fail -eq 0 ]; then echo "PASS: $n/$n 文件与本机运行时逐字节一致"; else echo "FAIL: 存在缺失或差异"; exit 1; fi
