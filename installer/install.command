#!/bin/bash
# Download the current official desktop and install OPL into its default ~/.dsh profile.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${OPL_SUITE_ROOT:-$HOME/Library/Application Support/OPL DSH Suite}"
APPS="${OPL_APPLICATIONS_DIR:-$HOME/Applications}"
APP="$APPS/DeepSeek Harness.app"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo '此安装器支持 Apple Silicon Mac。'; exit 1
fi
mkdir -p "$ROOT/cache" "$ROOT/runtime" "$APPS"
LOCK="$ROOT/install.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  OWNER_PID="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ "$OWNER_PID" =~ ^[0-9]+$ ]] && ! kill -0 "$OWNER_PID" 2>/dev/null; then
    rm "$LOCK/pid"; rmdir "$LOCK"; mkdir "$LOCK"
  else
    echo '另一个安装过程正在运行，请等待完成。'; exit 1
  fi
fi
echo "$$" > "$LOCK/pid"
STAGE=''
cleanup() {
  if [[ -n "$STAGE" ]]; then rm -rf "$STAGE"; fi
  rm -f "$LOCK/pid"; rmdir "$LOCK"
}
trap cleanup EXIT
if ps -axo command= | awk -v path="$APP/Contents/MacOS/DeepSeek Harness" 'index($0,path)==1 {found=1} END {exit !found}'; then
  echo '请先退出 DeepSeek Harness，再运行安装器。'; exit 1
fi
echo '正在检查 DeepSeek 官方桌面更新…'
FEED="$(curl --fail --silent --show-error --location --retry 2 --max-time 30 --proto '=https' --proto-redir '=https' 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml')"
FIELDS="$(printf '%s\n' "$FEED" | awk -f "$HERE/official-feed.awk")"
OFFICIAL_VERSION="$(printf '%s\n' "$FIELDS" | sed -n '1p')"
URL="$(printf '%s\n' "$FIELDS" | sed -n '2p')"
SHA512="$(printf '%s\n' "$FIELDS" | sed -n '3p')"
[[ "$OFFICIAL_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo '官方版本信息无效。'; exit 1; }
[[ "$URL" == "https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-$OFFICIAL_VERSION-mac-arm64.zip" ]] || { echo '官方更新地址无效。'; exit 1; }
[[ "$SHA512" =~ ^[A-Za-z0-9+/]{86}==$ ]] || { echo '官方校验信息无效。'; exit 1; }
NEED_INSTALL=1
CHECK_APP="$APP"
OLD_RUNTIME="$ROOT/runtime/DeepSeek Harness.app"
if [[ -f "$APP/Contents/Resources/opl-launcher-owner.txt" && -d "$OLD_RUNTIME" ]]; then
  mv "$APP" "$ROOT/runtime/OPL DSH.app.backup.$(date +%s)"
  mv "$OLD_RUNTIME" "$APP"
  CHECK_APP="$APP"
fi
if [[ -d "$CHECK_APP" ]]; then
  codesign --verify --deep --strict "$CHECK_APP"
  codesign -v -R='anchor apple generic and certificate leaf[subject.OU] = "NAN929V4UM" and identifier "com.deepseek.dsh"' "$CHECK_APP"
  INSTALLED="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$CHECK_APP/Contents/Info.plist")"
  # The official runtime provides semver; don't downgrade a newer installation.
  if ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" "$HERE/compare.cjs" "$APP" "$INSTALLED" "$OFFICIAL_VERSION"; then NEED_INSTALL=0; fi
fi
if [[ "$NEED_INSTALL" == 1 ]]; then
  ARCHIVE="${OPL_OFFICIAL_ARCHIVE:-$ROOT/cache/deepseek-harness-$OFFICIAL_VERSION.zip}"
  if [[ ! -f "$ARCHIVE" ]]; then
    echo "正在下载官方 DeepSeek Harness ${OFFICIAL_VERSION}…"
    curl --fail --location --retry 2 --proto '=https' --proto-redir '=https' "$URL" -o "$ARCHIVE.part"
    mv "$ARCHIVE.part" "$ARCHIVE"
  fi
  ACTUAL="$(openssl dgst -sha512 -binary "$ARCHIVE" | openssl base64 -A)"
  [[ "$ACTUAL" == "$SHA512" ]] || { echo '官方安装包校验失败，请删除缓存后重试。'; exit 1; }
  STAGE="$(mktemp -d "$ROOT/cache/unpack.XXXXXX")"
  ditto -x -k "$ARCHIVE" "$STAGE"
  codesign --verify --deep --strict "$STAGE/DeepSeek Harness.app"
  codesign -v -R='anchor apple generic and certificate leaf[subject.OU] = "NAN929V4UM" and identifier "com.deepseek.dsh"' "$STAGE/DeepSeek Harness.app"
  spctl --assess --type execute "$STAGE/DeepSeek Harness.app"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$STAGE/DeepSeek Harness.app/Contents/Info.plist")" == "$OFFICIAL_VERSION" ]] || { echo '官方版本与清单不符。'; exit 1; }
  if [[ -d "$APP" ]]; then mv "$APP" "$ROOT/runtime/DeepSeek Harness.backup.$(date +%s).app"; fi
  mkdir -p "$(dirname "$APP")"
  mv "$STAGE/DeepSeek Harness.app" "$APP"
fi
export NODE_USE_SYSTEM_CA=1
export ELECTRON_RUN_AS_NODE=1
if [[ "${OPL_INSTALL_NO_LAUNCH:-0}" == 1 ]]; then set -- "$@" --no-launch; fi
"$APP/Contents/MacOS/DeepSeek Harness" "$HERE/install.mjs" "$APP" "$ROOT" "$HERE" "$@"
