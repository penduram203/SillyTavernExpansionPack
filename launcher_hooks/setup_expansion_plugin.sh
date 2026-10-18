#!/usr/bin/env bash
# ============================================================
# SillyTavernExpansionPack - プラグイン自動配置スクリプト
# 使用方法: ./setup_expansion_plugin.sh <SillyTavernのルートパス>
# ============================================================
set -euo pipefail

ST_ROOT="${1:-}"
if [[ -z "$ST_ROOT" || ! -d "$ST_ROOT" ]]; then
    echo "[ExpansionPack] ❌ 有効な SillyTavern ルートパスを指定してください: $ST_ROOT"
    exit 1
fi

PLUGIN_ID="expansion-pack"
PLUGIN_DIR="$ST_ROOT/plugins/$PLUGIN_ID"
PLUGIN_FILE="$PLUGIN_DIR/index.js"
CONFIG_FILE="$ST_ROOT/config.yaml"

echo "[ExpansionPack] 🔧 プラグイン配置を開始: $PLUGIN_DIR"

# ── 1. プラグインディレクトリ作成 ──
mkdir -p "$PLUGIN_DIR"

# ── 2. index.js を生成（既存ファイルは上書きしない） ──
if [[ ! -f "$PLUGIN_FILE" ]]; then
    cat > "$PLUGIN_FILE" <<'PLUGIN_EOF'
const fs = require('fs');
const path = require('path');

async function init(router) {
    // ヘルスチェック用エンドポイント
    router.get('/health', (req, res) => {
        res.json({ ok: true, plugin: 'expansion-pack' });
    });

    // フォルダ作成用エンドポイント
    router.post('/create-folder', (req, res) => {
        try {
            const { path: relPath, base } = req.body || {};
            if (!relPath || base !== 'public') {
                return res.status(400).send('invalid request');
            }
            const normalized = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
            const targetDir = path.join(process.cwd(), 'public', normalized);
            const publicRoot = path.join(process.cwd(), 'public') + path.sep;
            if (!targetDir.startsWith(publicRoot)) {
                return res.status(403).send('forbidden');
            }
            fs.mkdirSync(targetDir, { recursive: true });
            res.json({ ok: true, path: targetDir });
        } catch (error) {
            res.status(500).send(error.message);
        }
    });
}

module.exports = {
    init,
    info: { id: 'expansion-pack', name: 'Expansion Pack', description: 'Media folder helper' },
};
PLUGIN_EOF
    echo "[ExpansionPack] ✅ index.js を生成しました"
else
    echo "[ExpansionPack] ℹ️ index.js は既に存在します（スキップ）"
fi

# ── 3. config.yaml の enableServerPlugins を true に設定 ──
if [[ -f "$CONFIG_FILE" ]]; then
    if grep -qE '^\s*enableServerPlugins\s*:\s*false' "$CONFIG_FILE"; then
        # false → true に置換
        sed -i 's/^\(\s*\)enableServerPlugins\s*:\s*false/\1enableServerPlugins: true/' "$CONFIG_FILE"
        echo "[ExpansionPack] ✅ config.yaml の enableServerPlugins を true に変更しました"
    elif grep -qE '^\s*enableServerPlugins\s*:\s*true' "$CONFIG_FILE"; then
        echo "[ExpansionPack] ℹ️ enableServerPlugins は既に true です"
    else
        # 行が存在しない場合は末尾に追加
        echo -e "\nenableServerPlugins: true" >> "$CONFIG_FILE"
        echo "[ExpansionPack] ✅ config.yaml に enableServerPlugins: true を追加しました"
    fi
else
    echo "[ExpansionPack] ⚠️ config.yaml が見つかりません: $CONFIG_FILE"
    exit 1
fi

echo "[ExpansionPack] 🎉 プラグイン配置が完了しました"
