#!/usr/bin/env bash
# ============================================================
# SillyTavern-Launcher を ExpansionPack プラグイン付きで起動するラッパー
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER_DIR="${SILLYTAVERN_LAUNCHER_DIR:-$HOME/SillyTavern-Launcher}"
ST_INSTALL_DIR="${SILLYTAVERN_DIR:-$LAUNCHER_DIR/SillyTavern}"

echo "[ExpansionPack] 🚀 ラッパー起動を開始"

# ── SillyTavern のルートを自動検出 ──
if [[ ! -d "$ST_INSTALL_DIR" ]]; then
    # ランチャー配下の一般的なパスを探索
    for candidate in "$LAUNCHER_DIR/SillyTavern" "$LAUNCHER_DIR/sillytavern" "$LAUNCHER_DIR/ST"; do
        if [[ -d "$candidate" ]]; then
            ST_INSTALL_DIR="$candidate"
            break
        fi
    done
fi

if [[ ! -d "$ST_INSTALL_DIR" ]]; then
    echo "[ExpansionPack] ⚠️ SillyTavern のインストール先が見つかりません。環境変数 SILLYTAVERN_DIR を設定してください。"
    echo "[ExpansionPack] ℹ️ ランチャーをそのまま起動します..."
    exec bash "$LAUNCHER_DIR/launcher.sh" "$@"
fi

# ── プラグインを自動配置 ──
bash "$SCRIPT_DIR/setup_expansion_plugin.sh" "$ST_INSTALL_DIR" || {
    echo "[ExpansionPack] ⚠️ プラグイン配置に失敗しましたが、ランチャーは続行します"
}

# ── ランチャー本体を起動 ──
echo "[ExpansionPack] ✅ ランチャーを起動します..."
exec bash "$LAUNCHER_DIR/launcher.sh" "$@"
