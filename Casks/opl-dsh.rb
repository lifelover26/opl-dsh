cask "opl-dsh" do
  version "0.2.53"
  sha256 "79c3d82c9949c4e27dd0e110ae5746da6e89f3639c2ba0debdde989f465da6e1"

  url "https://github.com/gaofeng21cn/opl-dsh/releases/download/opl-dsh-v#{version}/OPL-DSH-Enhancements.zip"
  name "OPL DSH"
  desc "Official DeepSeek Harness desktop with OPL Gateway and Codex collaboration"
  homepage "https://github.com/gaofeng21cn/opl-dsh"

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  installer script: {
    executable: "/bin/bash",
    args:       ["-c", <<~EOS, "--", staged_path],
      set -euo pipefail
      /bin/bash "$1/install.command" --no-launch
      root="${OPL_SUITE_ROOT:-$HOME/Library/Application Support/OPL DSH Suite}"
      expected=$(/usr/bin/plutil -extract suiteSha256 raw -o - "$1/artifact.json")
      actual=$(/usr/bin/plutil -extract suiteSha256 raw -o - "$root/installation.json")
      [[ "$actual" == "$expected" ]] || { echo 'OPL DSH 安装记录与增强包不符。' >&2; exit 1; }
    EOS
    sudo:       false,
  }

  # Only remove shortcuts owned by this suite. Keep the official app and user data.
  uninstall script: {
    executable: "/bin/bash",
    args:       ["-c", <<~EOS],
      root="$HOME/Library/Application Support/OPL DSH Suite"
      shortcut="$HOME/Applications/OPL DSH.command"
      if [[ -f "$shortcut" ]] && /usr/bin/grep -Fq "$root/launch.command" "$shortcut"; then
        rm -f "$shortcut"
      fi
    EOS
    sudo:       false,
  }

  caveats <<~EOS
    直接打开 ~/Applications/DeepSeek Harness.app，即可使用官方桌面与 OPL 增强。
    OPL DSH 兼容入口仅用于维护和增强更新。
    安装时获取最新官方桌面，并自动配置 Codex Skill。
    官方桌面和增强分别更新；Cask 版本仅标识安装器版本。
    卸载仅移除 OPL 快捷入口，保留官方桌面、数据及 Codex Skill。
  EOS
end
