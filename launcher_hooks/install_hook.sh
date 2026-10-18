#!/usr/bin/env bash
# ============================================================
# SillyTavernExpansionPack - 初回セットアップ（1コマンド実行用）
# 使用方法: bash install_hook.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER_DIR="${SILLYTAVERN_LAUNCHER_DIR:-$HOME/SillyTavern-Launcher}"
ST_INSTALL_DIR="${SILLYTAVERN_DIR:-$LAUNCHER_DIR/SillyTavern}"

echo "════════════════════════════════════════════════════════"
echo "  SillyTavernExpansionPack フック登録インストーラー"
echo "════════════════════════════════════════════════════════"

# ── 1. SillyTavern ルートの自動検出 ──
if [[ ! -d "$ST_INSTALL_DIR" ]]; then
    for candidate in "$LAUNCHER_DIR/SillyTavern" "$LAUNCHER_DIR/sillytavern" "$HOME/SillyTavern"; do
        if [[ -d "$candidate" ]]; then
            ST_INSTALL_DIR="$candidate"
            break
        fi
    done
fi
if [[ ! -d "$ST_INSTALL_DIR" ]]; then
    echo "❌ SillyTavern のインストール先が見つかりません。"
    echo "   SILLYTAVERN_DIR 環境変数で指定してください。"
    exit 1
fi
echo "✅ SillyTavern: $ST_INSTALL_DIR"

# ── 2. プラグインを初回配置 ──
bash "$SCRIPT_DIR/setup_expansion_plugin.sh" "$ST_INSTALL_DIR"

# ── 3. .desktop ファイルの自動書換 ──
DESKTOP_CANDIDATES=(
    "$HOME/.local/share/applications/SillyTavern.desktop"
    "$HOME/.local/share/applications/sillytavern-launcher.desktop"
    "$HOME/Desktop/SillyTavern.desktop"
)
WRAPPER_PATH="$SCRIPT_DIR/launch_with_expansion.sh"

for desktop in "${DESKTOP_CANDIDATES[@]}"; do
    if [[ -f "$desktop" ]]; then
        if grep -q "launch_with_expansion.sh" "$desktop"; then
            echo "ℹ️ .desktop は既に設定済み: $desktop"
        else
            cp "$desktop" "${desktop}.bak.$(date +%Y%m%d%H%M%S)"
            sed -i "s|^Exec=.*|Exec=bash \"$WRAPPER_PATH\"|" "$desktop"
            echo "✅ .desktop を書き換えました: $desktop"
        fi
    fi
done

echo ""
echo "🎉 セットアップ完了！次回からは通常通りランチャーを起動するだけで"
echo "   プラグインが自動配置されます。"
echo ""
echo "💡 ターミナルから直接起動する場合は:"
echo "   bash $WRAPPER_PATH"
