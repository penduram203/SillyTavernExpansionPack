#!/bin/bash
# migrate_videos.sh
# 動画を charName/ から charName_video/ へ移動し、サムネイルPNGを生成する
#
# 使い方:
#   bash migrate_videos.sh 咲葉学園             # 一度だけ実行
#   bash migrate_videos.sh --watch 咲葉学園      # 30秒毎に監視（新規動画を自動移行）
#
# 環境変数:
#   ST_ROOT   SillyTavern のルートパス（自動検出できなければ指定）
#   WATCH_INTERVAL  監視間隔秒（デフォルト30）

set -e

# ── 引数パース ──
WATCH_MODE=0
if [ "$1" = "--watch" ]; then
    WATCH_MODE=1
    shift
fi
CHAR_NAME="${1:-}"
if [ -z "$CHAR_NAME" ]; then
    echo "Usage: $0 [--watch] <character_name>"
    echo "Example: $0 咲葉学園"
    exit 1
fi

# ── ST_ROOT 自動検出 ──
if [ -z "$ST_ROOT" ]; then
    for candidate in \
        "/content/SillyTavern" \
        "$HOME/SillyTavern" \
        "/opt/SillyTavern" \
        "$(pwd)"; do
        if [ -d "$candidate/data/default-user/user/images" ]; then
            ST_ROOT="$candidate"
            break
        fi
    done
fi
if [ -z "$ST_ROOT" ] || [ ! -d "$ST_ROOT/data/default-user/user/images" ]; then
    echo "Error: ST_ROOT が見つかりません。環境変数で指定してください:"
    echo "  ST_ROOT=/path/to/SillyTavern bash $0 $CHAR_NAME"
    exit 1
fi

IMAGES_DIR="$ST_ROOT/data/default-user/user/images"
CHAR_DIR="$IMAGES_DIR/$CHAR_NAME"
VIDEO_DIR="$IMAGES_DIR/${CHAR_NAME}_video"

if [ ! -d "$CHAR_DIR" ]; then
    echo "Error: $CHAR_DIR が見つかりません"
    exit 1
fi

# ── ffmpeg チェック ──
HAS_FFMPEG=0
if command -v ffmpeg >/dev/null 2>&1; then
    HAS_FFMPEG=1
fi

# ── 1回分の移行処理 ──
migrate_once() {
    mkdir -p "$VIDEO_DIR"
    local moved=0
    local thumbed=0
    local skipped=0

    shopt -s nullglob
    for f in "$CHAR_DIR"/*.mp4 "$CHAR_DIR"/*.webm; do
        local base name ext thumb target
        base=$(basename "$f")
        name="${base%.*}"
        ext="${base##*.}"
        thumb="$CHAR_DIR/${name}_${ext}_thum.png"
        target="$VIDEO_DIR/$base"

        # 既に同名ファイルが移動先にある → 元を削除のみ
        if [ -f "$target" ]; then
            echo "  [skip-move] $base (既に移動先に存在)"
            rm -f "$f"
            skipped=$((skipped + 1))
        else
            mv "$f" "$target"
            echo "  [moved] $base → ${CHAR_NAME}_video/"
            moved=$((moved + 1))
        fi

        # サムネイル生成（既存ならスキップ）
        if [ -f "$thumb" ]; then
            continue
        fi
        if [ $HAS_FFMPEG -eq 1 ]; then
            ffmpeg -y -i "$target" -vframes 1 \
                -vf "scale=200:200:force_original_aspect_ratio=decrease,pad=200:200:(ow-iw)/2:(oh-ih)/2:color=black" \
                "$thumb" -loglevel error 2>/dev/null
            if [ -f "$thumb" ]; then
                echo "  [thumb] ${name}_${ext}_thum.png"
                thumbed=$((thumbed + 1))
            fi
        fi
    done
    shopt -u nullglob

    if [ $moved -eq 0 ] && [ $thumbed -eq 0 ] && [ $skipped -eq 0 ]; then
        return 1  # 何もしなかった
    fi
    echo "  完了: moved=$moved, thumbed=$thumbed, skipped=$skipped"
    return 0
}

# ── メイン ──
echo "=== Video Migration ==="
echo "  Character : $CHAR_NAME"
echo "  Image dir : $CHAR_DIR"
echo "  Video dir : $VIDEO_DIR"
echo "  ffmpeg    : $([ $HAS_FFMPEG -eq 1 ] && echo 'yes' || echo 'NO (install with: apt-get install -y ffmpeg)')"
echo ""

if [ $WATCH_MODE -eq 1 ]; then
    INTERVAL="${WATCH_INTERVAL:-30}"
    echo "監視モード開始（${INTERVAL}秒間隔）。Ctrl+C で停止。"
    while true; do
        migrate_once || true
        sleep "$INTERVAL"
    done
else
    migrate_once || echo "  （移行対象の動画なし）"
fi

echo ""
echo "=== 次の手順 ==="
echo "1. ブラウザで Ctrl+Shift+R ハードリロード"
echo "2. ギャラリーを開いて動作確認"
echo "3. 新規動画を自動移行したい場合: bash $0 --watch $CHAR_NAME &"
