# SillyTavern Expansion Pack

複数の SillyTavern 拡張機能を 1 つのリポジトリに統合したパッケージです。
SillyTavern の「拡張機能をインストール」から本リポジトリの URL を指定するだけで、
含まれるすべての拡張がまとめてインストール・更新されます。

---

## 目次

1. [動作環境](#動作環境)
2. [クイックスタート](#クイックスタート)
3. [同梱拡張一覧（サマリ）](#同梱拡張一覧サマリ)
4. [各拡張の詳細](#各拡張の詳細)
5. [データ保存先](#データ保存先)
6. [公開 API 一覧](#公開-api-一覧)
7. [インストール / 更新 / アンインストール](#インストール--更新--アンインストール)
8. [設定・カスタマイズ](#設定カスタマイズ)
9. [トラブルシューティング](#トラブルシューティング)
10. [既知の制限事項](#既知の制限事項)
11. [ディレクトリ構成](#ディレクトリ構成)
12. [ライセンス](#ライセンス)

---

## 動作環境

本パックは以下の環境で動作確認済みです。

| 項目 | 内容 |
|---|---|
| OS | Zorin OS（Ubuntu 系 Linux）　Windowsでも多分動くと思います |
| ブラウザ | Firefox（最新版） |
| SillyTavern | 1.12 以降推奨 |
| 言語モデル | KoboldCpp / OpenAI / Google AI Studio（Gemini）等 |
| 画像生成 | Stable Diffusion 拡張 + ComfyUI（ローカル or Colab + localtunnel） |
| ComfyUI URL | ローカル（`http://127.0.0.1:8188`）または外部（`https://xxxx.loca.lt` 等） |

> **Note**: ComfyUI が未起動の場合、本パックは自動的に SD ソースを `none` に
> 切り替えます。外部 URL（localtunnel 等）が SD 設定に登録されている場合は
> ブロックせず、そのまま接続を試みます。

---

## クイックスタート

1. SillyTavern の「拡張機能 → 拡張機能をインストール」から本リポジトリの URL を指定
2. SillyTavern を F5 リロード
3. チャット画面左下に以下のボタン群が表示されることを確認:
   ```
           削除  🎨
           解除  💡
           Ｔ   中央
   ```
4. キャラクターを選択 → 同名のロアブックが自動生成され、バインドされます
   （`00_共通ルール` エントリ入り）
5. チャットを開始 → 選択肢番号（例: `001`）を送信すると画像が自動生成されます

---

## 同梱拡張一覧（サマリ）

| # | 拡張名 | 主な役割 |
|---|---|---|
| 1 | Chat Window On/Off | 💡 ボタンでチャットウィンドウの透過切替 |
| 2 | Right Nav Panel Customizer | 右ナビのキャラ一覧をグリッド + 大サムネ化 |
| 3 | STJ Character Exporter | キーワード→画像マッピングの JSON 編集・出力 |
| 4 | Text Styling | テキストスタイル / レイアウトモード切替 |
| 5 | Image Display | キーワードで背景画像を切替・表示 |
| 6 | Lorebook Expansion | エントリに画像プロンプト等を付与 |
| 7 | Generate Image Controller (GIC) | 選択肢番号で画像自動生成 + 背景表示 |
| 8 | Worldbook Auto Select | キャラ切替時にロアブックを自動選択・作成 |
| 9 | Variable Manager | RPG モード・バトル・変数パネル |
| 10 | User Status | プレイヤー HP 表示 |
| 11 | Choice Click | 選択肢クリック・ゲーム開始ボタン |
| 12 | KeyConfig | キーボードで選択肢を操作 |
| 13 | Status Indicator | 応答生成中/画像生成中のインジケータ |
| 14 | Sound Effects | バトル等の効果音再生 |
| 15 | Random Prompt Wildcard | プロンプトのワイルドカード + 推奨 LoRA 管理 |
| 16 | Character Store（内部） | `char.data.extensions` の保存ヘルパー |
| 17 | Console Filter | 開発ログのノイズ抑制 |

---

## 各拡張の詳細

### 1. Chat Window On/Off

チャットウィンドウの表示/非表示を左下の **💡 ボタン** でワンクリック切り替え。

- 状態はブラウザに保存され、次回起動時に復元
- T パネル表示中 / ギャラリー表示中 / バトル中は自動無効化
- STJ エディタ表示中は全ボタン非表示

### 2. Right Nav Panel Customizer

右側「キャラクター管理」パネルのキャラ一覧をグリッド表示・大サムネイル化。

- `image_display_extension.thumbnail` の画像をアバターに差し替え
- `thumbnail` 未設定時は通常アバター表示

### 3. STJ Character Exporter

キャラクターの「キーワード → 表示画像」マッピングを JSON 形式で編集する拡張。

**主な機能**:
- デフォルト画像 / サムネイル画像 / キーワードごとの画像を設定
- セルへのドラッグ&ドロップ、セル入れ替え、一括削除、複数選択
- リアルタイムキーワード反応テスト
- **ロアブックと自動同期**: キャラのロアブックに存在するエントリのみセル化
- **画像の自動復元**: `image_display_bag_state` やディスクスキャンから
  消失したマッピングを復元

**保存先**: `char.data.extensions.image_display_extension`
（`_ext.json` からの移行は不要・自動）

### 4. Text Styling

`<p>` / `<q>` タグごとの文字スタイル、チャットウィンドウの透過度、
レイアウトモード（中央 / 左右 / 手動）の切替。

- 左下の **Ｔ アイコン** で設定パネルを開閉
- **中央ボタン** でレイアウトモードをサイクル切替

### 5. Image Display

キーワードに応じて背景画像を表示するドラッグ&リサイズ可能なウィンドウ。

**主な機能**:
- キーワード条件は `and` / `or` / `!` / 括弧グループ化に対応
- 画像が配列の場合は**シャッフルバッグ方式**で半ランダム選択
  （全画像を表示し終えるまで同じ画像は出ない）
- バトルモード中は背景画像をロック
- GIF / APNG のアニメーション判定、動画背景対応
- 状態は `image_display_bag_state` としてキャラ毎に永続化

### 6. Lorebook Expansion

ロアブックの各エントリに以下を付与:

- **Img_prompt**: 画像生成プロンプト（GIC が読み取る）
- **Negative_prompt**: ネガティブプロンプト（2行テキストエリア）
- **Resolution**: 画像解像度（テンプレート毎に設定可能、ランダム可）
- **templates / selectedTemplate**: 複数プロンプトのテンプレート切替
- **variables**: 変数管理（Variable Manager が読み取る）
- **choices**: 応答末尾に自動表示される選択肢

**データ保存先**: `extension_settings.lorebook_expansion.data[worldName][charKey]`
（per-world ストア。`charKey` は comment 正規化 → keys[0] → uid の順で決定）

### 7. Generate Image Controller (GIC)

ロアブックの選択肢番号をトリガーに画像を自動生成する統合コントローラ。

**主な機能**:
- 選択肢番号（3桁）を送信 → `Img_prompt` に基づいて `/sd` 実行
- 生成画像を背景として表示（**合体モード固定**）
- 生成画像を `キャラ名_エントリキー_タイムスタンプ.png` に自動リネーム
- 公式ギャラリーの強化（ページネーション・一括削除・ウォームアップ）
- 画像サムネイル・動画サムネイルの IndexedDB キャッシュ
- **空保存ガード**: `/api/worldinfo/edit` をインターセプトして
  ST 本体の空保存を防ぐ
- **ロアブック自動作成失敗時の自己修復**

**UI（左下ボタン群）**:
```
        削除  🎨      削除 = ローカルディスクから画像削除
        解除  💡      解除 = セルから登録解除
        Ｔ   中央      T = 設定パネル / 中央 = レイアウトモード
```

**手動コマンド**:
- `/gic-sd` — 直前ユーザーメッセージから番号抽出して画像生成
- `/gic-test` — ロアブック/ストア状態の診断表示

### 8. Worldbook Auto Select

キャラクター切替時に、同名のロアブックを自動選択・自動作成・バインド。

**主な機能**:
- ロアブックが無ければ自動作成（`00_共通ルール` エントリ入り）
- `char.data.extensions.world` に自動バインド
- **リロード不要**: ST 公式 API (`saveWorldInfo`, `reloadWorldInfoEditor`,
  `updateWorldInfoList`) を経由してキャッシュ・UI を正規更新
- **エディタ空表示の自己修復**: サーバー内容でキャッシュを上書きして再読込
- **新規エントリ初期値設定**: 「New Entry」ボタンで作成したエントリに
  `WI Entry Status=Normal` / `position=@D System` / `depth=0` を自動適用
- **comment→key 自動同期**: 「エントリータイトル/メモ」を編集すると
  「カンマ区切りリスト」にも同じ内容が自動入力される（パネル開閉状態に非依存）

### 9. Variable Manager (RPG モード)

画面左上に現在エントリの変数値を表示。`00_共通ルール` の制御変数で挙動が変わります。

| 変数名 | 効果 |
|---|---|
| `RPGモード` | 変数パネル・プレイヤー HP 表示・バトル開始ボタンの前提 |
| `バトル開始` | AI メッセージ末尾に「バトル開始」ボタンを表示 |
| `選択肢モード` | 「ゲーム開始」ボタン表示（Choice Click 用） |
| `タイトル画面` | スタート/ロード画面を表示 |
| `チャットウィンドウ` | `#sheld` の表示/非表示（RPG モード時のみ有効） |
| `バトルモード` | 実際のバトル進行状態（攻撃/防御/道具/逃走） |

**戦闘**: 攻撃・防御・逃走の動作を実装。敵 HP ≤ 0 / 逃走でバトル終了、
`999` エントリの自動ロード、プレイヤー HP 管理（User Status と連携）。

### 10. User Status

画面左下にプレイヤー（ペルソナ）の HP バーを表示。

- デフォルト: 最大 HP 500 / 現在 HP 500
- **RPGモード=1 の時のみ表示**
- キャラ未選択時は絶対非表示
- リセットボタン押下時のみ全回復（バトル敗北時は維持）

### 11. Choice Click

ロアブック選択肢（`.lbe-choice-item`）をクリック可能にする拡張。

- **通常クリック**: 選択肢番号を送信（自動送信）
- **Shift+クリック**: 入力欄にセットするだけ
- **ゲーム開始ボタン**: `選択肢モード=1` の時、first_mes 末尾に表示
- **リセットボタン**: チャットをリセットして最初からやり直す
  （ダイアログは自動解決）

### 12. KeyConfig

キーボードで選択肢・開始ボタンを操作。

| キー | 動作 |
|---|---|
| `↑` / `W` | 前の要素へ |
| `↓` / `S` | 次の要素へ |
| `Enter` / `E` / `F` | 決定（`.click()`） |
| `Space` | チャットウィンドウの表示切替 |
| `←` / `→` | 常にブロック（ST スワイプ誤爆防止） |

タイトル画面では `←/→` または `A/D` で選択、`E/F/Enter` で決定。

### 13. Status Indicator

画面下部に「応答生成中…」（📃）/「画像生成中…」（📷）/モード表示（⚙️）を表示。

- ホバー時に data-tooltip を即座表示（独自実装）
- `gic-image-generation-started/ended` カスタムイベントで連携

### 14. Sound Effects

バトル等の効果音を再生。`window.SoundEffects.play('attack')` で呼び出し。

**対応音声**: `attack` / `defense` / `item` / `escape` / `enemy_attack` / `interface7`

`audio/` フォルダに `.opus` / `.ogg` / `.mp3` / `.wav` のいずれかを配置すれば自動検出。
ブラウザ非対応形式は `canPlayType()` で自動スキップ。

### 15. Random Prompt Wildcard

プロンプトのワイルドカード（ランダム置換）とキャラ推奨 LoRA の管理。

**ワイルドカード**:
- キャラ毎に `変数名 = 値1,値2,値3` を定義
- 画像生成プロンプト中の `変数名` がランダムに置換
- **同一生成内では同じ変数は同じ値**（一貫性保証）
- 例: `color1? = black,brown,pink` → `color1? hair, color1? eyes` が
  `pink hair, pink eyes` のように展開

**キャラ推奨 LoRA**:
- キャラ毎に推奨 LoRA の名前・DL URL・トリガーワード・説明を登録
- モーダル下部に LoRA の使い方ヘルプを表示

### 16. Character Store（内部モジュール）

`char.data.extensions.{namespace}` の読み書きを一元化。

- 保存は 100ms debounce、失敗時は 1s/2s/5s でリトライ
- `_backup` を avatar キーで管理（キャラ間の混入を構造的に排除）
- `/api/characters/merge-attributes` / `/api/characters/edit` を
  fetch インターセプトして backup を注入
- JSON / PNG エクスポート前に `char.data.extensions` の内容を復元

### 17. Console Filter

コンソールログのノイズを抑制（`console.log` / `debug` / `info` のみ）。

- `console.warn` / `console.error` は**常に通す**（重要なので）
- ポーリング・再描画・状態同期などの定常ログをパターンマッチで抑制
- デフォルト ON、`localStorage` に状態保存

**使い方**:
```js
ConsoleFilter.disable();          // 全ログ表示（デバッグ時）
ConsoleFilter.enable();           // フィルタ ON（デフォルト）
ConsoleFilter.setVerbose(true);   // 抑制したログを [FILTERED] として残す
ConsoleFilter.mute(2000);         // 2 秒だけ全ログ表示
ConsoleFilter.stats();            // 現在の統計
```

---

## データ保存先

本パックのデータは以下の場所に保存されます。

### SillyTavern グローバル設定

`extension_settings` 以下に各拡張の設定を保存:

| キー | 内容 |
|---|---|
| `extension_settings.lorebook_expansion` | LEX 設定 + per-world ストア（`data[worldName][charKey]`） |
| `extension_settings.gic_lorebook_sd` | GIC-Lore 設定（トリガー・quiet 等） |
| `extension_settings.image_display` | Image Display のウィンドウ位置・サイズ |
| `extension_settings.text_styling` | テキストスタイル設定 |
| `extension_settings.variable_manager` | RPG モード・バトルステート |
| `extension_settings.user_status` | プレイヤー HP |
| `extension_settings.worldbook_auto_select` | WBAutoSelect 設定 |
| `extension_settings.chat_window_onoff` | 💡 透過状態 |
| `extension_settings.choice_click` | 開始ボタン状態 |

### キャラクター固有データ

`char.data.extensions.{namespace}` に保存:

| キー | 内容 |
|---|---|
| `image_display_extension` | キーワード → 画像パスのマッピング |
| `image_display_bag_state` | シャッフルバッグの表示済みフラグ |
| `image_display_extension_meta` | マイグレーションフラグ |
| `lorebook_expansion` | per-world ストアの JSON エクスポート用ミラー |
| `random_prompt_wildcard` | ワイルドカード定義 |
| `character_recommended_lora` | 推奨 LoRA リスト |

### サーバーファイル

| パス | 用途 |
|---|---|
| `data/default-user/worlds/<worldName>.json` | ロアブック本体 |
| `data/default-user/user/images/<charName>/*.png` | 生成画像 |
| `data/default-user/user/images/default.png` | フォールバック画像 |

---

## 公開 API 一覧

デバッグ・外部連携用に以下のグローバル API を公開しています。

### `window.LorebookExpansion`

```js
LorebookExpansion.getDataFor(worldName, uid, entry);   // LEX データ取得
LorebookExpansion.setDataFor(worldName, uid, entry, data);
LorebookExpansion.getCurrentWorldName();
LorebookExpansion.loadWorldInfoEntriesByName(name);    // キャッシュ経由
LorebookExpansion.clearWorldInfoEntriesCache(name);
LorebookExpansion.refreshAllChoicesBlocks();           // 選択肢再描画
LorebookExpansion.forceInject();                       // UI 手動注入
LorebookExpansion.debugInfo();                         // 診断
LorebookExpansion.setDebug(true);                      // デバッグモード
```

### `window.GicLorebook`

```js
GicLorebook.processChoice(force);                      // 画像生成メイン
GicLorebook.extractChoiceNumber(text);
GicLorebook.executeSd(prompt, negativePrompt, res);
GicLorebook.getPendingGenerationContext();
GicLorebook.resetDedup();
```

### `window.GicApi`

```js
GicApi.openGallery();
GicApi.closeGallery();
GicApi.isOpen();
GicApi.forceRefreshGallery();                          // ギャラリー手動更新
GicApi.clearImageCacheForChar(charName);
GicApi.ensureThumbnailForVideo(videoFile, charName);
GicApi.ensureImageThumbnail(imageFile, charName);
GicApi.getImageCacheStats();
GicApi.unregisterCurrentImage();
GicApi.getCurrentlyRegisteredImage();
```

### `window.WorldbookAutoSelect`

```js
WorldbookAutoSelect.run(reason);
WorldbookAutoSelect.createWorldbook(name);
WorldbookAutoSelect.selfHealNow();                     // 手動自己修復
WorldbookAutoSelect.diagnose();                        // 状態ダンプ
WorldbookAutoSelect.setCommentToKeySync(true/false);
WorldbookAutoSelect.syncCommentToKeyNow();
```

### `window.ImageDisplayExtension`

```js
ImageDisplayExtension.getCurrentImageUrl();
ImageDisplayExtension.applyNormalMode();               // 通常サイズ
ImageDisplayExtension.applyMaximizeMode();             // 最大化
ImageDisplayExtension.applyHalfMaximizeMode();         // 左半分
ImageDisplayExtension.getBagState();                   // バッグ状態
ImageDisplayExtension.resetBagState();
```

### `window.VariableManager`

```js
VariableManager.refreshCommonRuleFlags();
VariableManager.getCommonRuleFlags();
VariableManager.isBattleActive();
VariableManager.startBattle();
VariableManager.endBattle();
VariableManager.setCommonRuleVariable(name, value);
VariableManager._debug();                              // 状態ダンプ
```

### `window.CharStore`

```js
CharStore.saveCharacterExtension(namespace, payload, { immediate });
CharStore.flushCharacterExtension(namespace);
CharStore.flushAll();
CharStore._dumpBackup();
```

### `window.STJEditor`

```js
STJEditor.open();
STJEditor.close();
STJEditor.isOpen();
STJEditor.restoreAllKeys();                            // 画像マップ一括復元
STJEditor.cleanMissingFiles();
STJEditor.syncLorebookEntries();
```

### その他

- `window.SoundEffects` — `play(name)`, `preload()`
- `window.StatusIndicator` — `show(key, text, type)`, `hide(key)`
- `window.ChoiceClick` — `bind()`, `updateColors()`, `setupGameStart()`
- `window.KeyConfig` — `refresh()`, `getContextName()`, `getMode()`
- `window.RandomPromptWildcard` — `applyToPrompt(text)`, `openModal()`
- `window.CharacterRecommendedLora` — `openModal()`, `getCurrentLoras()`
- `window.ConsoleFilter` — `enable()`, `disable()`, `setVerbose()`, `mute()`

---

## インストール / 更新 / アンインストール

### インストール

1. SillyTavern の拡張機能パネルを開く
2. 「拡張機能をインストール」をクリック
3. 本リポジトリの URL を貼り付けて保存
4. SillyTavern を F5 リロード

### 更新

拡張機能管理画面から「更新」をクリック、または ST 本体の更新に追従
（`auto_update` 有効時）。

### アンインストール

拡張機能管理画面から本パックを削除してください。
**注意**: 削除しても `extension_settings` / `char.data.extensions` の
データは残ります。完全削除する場合は手動で削除してください。

---

## 設定・カスタマイズ

### 拡張パック全体のログ抑制

```js
// デフォルトは ON
ConsoleFilter.disable();   // 全ログ表示（開発時）
```

### 画像生成の解像度

各エントリの `Resolution`（Lorebook Expansion）で指定。`random` を選ぶと
SD 拡張が対応している解像度からランダム選択されます。

### ワイルドカードの例

```
color1? = black,brown,orange,yellow,pink
eyes? = blue,green,red
style? = "soft, pastel", "sharp, realistic"
```

`Img_prompt` に `color1? hair, eyes? eyes, style?` と書けば、生成毎に
ランダムに展開されます（同一生成内で同じ変数は同じ値）。

### 推奨 LoRA の登録

`Random Prompt Wildcard` モーダル下部の「キャラ推奨LoRA」ボタンから登録。
`<lora:ファイル名:強度>` をプロンプトに追加する形で使用します。

---

## トラブルシューティング

### ComfyUI が検出されない

- **ローカル環境**: ComfyUI が `http://127.0.0.1:8188` で起動しているか確認
- **Colab + localtunnel**: SD 設定の「ComfyUI URL」に外部 URL を登録
  - 登録があれば `comfy_boot.js` は fetch をブロックしません
- ComfyUI 未起動時は自動的に `sd.source = 'none'` に切り替わります

### ロアブックが自動作成されるがエントリが空

本パックは以下の多層防御で防止しますが、万一発生した場合:

1. `WorldbookAutoSelect.selfHealNow()` を実行
2. ブラウザを F5 リロード（サーバーファイルは正常なため、メモリキャッシュが
   リセットされれば復旧）

### 画像マッピングが消えた

`STJEditor.restoreAllKeys()` を実行すると、`image_display_bag_state` と
ディスクスキャンから復元されます。

```js
await window.STJEditor.restoreAllKeys();
// → { ok: true, restored: 17, keys: [...], detail: {...} }
```

### 画像が表示されない / 🎨 が動かない

- ブラウザキャッシュをクリア（Ctrl+Shift+R）
- `GicApi.forceRefreshGallery()` で手動リフレッシュ
- コンソールで `[GIC]` のエラーログを確認

### 効果音が再生されない

- `audio/` フォルダに音声ファイルを配置
- Firefox はユーザー操作前の自動再生を制限 → 最初のクリック後に有効化

### ボタンが表示されない

- `chat_window_onoff.js` / `gic.js` の SyntaxError をコンソールで確認
- `window.debugButtonPositions()` で各ボタンの実効位置を確認
- 定数の重複宣言（`WCB_LEFT_OFFSET_PX` など）がないか確認

---

## 既知の制限事項

- **Firefox の CORS**: ComfyUI が `127.0.0.1:8188` で CORS を許可していない場合、
  プローブが失敗します。ComfyUI 側で `--enable-cors-header` を指定してください
- **localtunnel の制限**: 無料版は帯域制限・セッションタイムアウトあり
- **ロアブック自動作成のレース条件**: ST 本体の `saveWorldInfo` と本パックの
  `WBAutoSelect` が同時に走ると、稀に空エントリで上書きされることがあります。
  本パックは `/api/worldinfo/edit` の fetch インターセプトで防御していますが、
  完全ではありません。`selfHealNow()` で復旧可能です
- **画像生成の同時実行**: `/sd` は同時 1 リクエストのみ。連続送信すると
  2 つ目以降は無視されます
- **`image_display_bag_state` の肥大化**: 画像が多いキャラは localStorage を
  圧迫する可能性があります。定期的に `resetBagState()` でクリアしてください

---

## ディレクトリ構成

```
SillyTavernExpansionPack/
├── manifest.json
├── README.md
├── index.js                       # ST 拡張ローダー用エントリ
├── modules/
│   ├── comfy_boot.js              # ComfyUI 未検出時の fetch ブロック
│   ├── console_filter.js          # コンソールログ抑制
│   ├── character_store.js         # char.data 保存ヘルパー
│   ├── chat_window_onoff.js       # 💡 透過切替
│   ├── choice_click.js            # 選択肢クリック / 開始ボタン
│   ├── gic.js                     # 画像生成コントローラ本体
│   ├── gic_lorebook.js            # ロアブック駆動の画像生成
│   ├── image-display.js           # 背景画像表示
│   ├── keyconfig.js               # キーボード操作
│   ├── Lorebook_Expansion.js      # ロアブックエントリ拡張
│   ├── media_controller.js        # メディアホバー制御
│   ├── random_prompt_wildcard.js  # ワイルドカード / 推奨 LoRA
│   ├── right_nav_kai.js           # 右ナビ改変
│   ├── sound_effects.js           # 効果音
│   ├── status_indicator.js        # ステータス表示
│   ├── stj_editor.js              # JSON エディタ
│   ├── text-styling.js            # テキストスタイル
│   ├── user_status.js             # プレイヤー HP
│   ├── variable_manager.js        # RPG モード / バトル
│   └── worldbook_auto_select.js   # ロアブック自動選択
├── styles/
│   ├── Lorebook_Expansion.css
│   ├── chat_window_onoff.css
│   ├── choice_click.css
│   ├── image-display.css
│   ├── keyconfig.css
│   ├── right_nav_kai.css
│   ├── status_indicator.css
│   ├── stj_editor.css
│   ├── text-styling.css
│   ├── user_status.css
│   └── variable_manager.css
└── audio/
    ├── attack.opus
    ├── enemy_attack.opus
    ├── interface7.opus
    └── ...（任意）
```

---

## ライセンス

MIT License

本パックは SillyTavern 本体とは独立した拡張機能です。
SillyTavern 本体のライセンス（AGPL-3.0）には従いません。

---

## 更新履歴（抜粋）

- **v8.6** (Worldbook Auto Select): payload auto-sync 方式に移行
- **v8.5** (Worldbook Auto Select): comment→key 同期の改善
- **v8.3** (Worldbook Auto Select): パネル非依存の同期
- **v1.0** (Console Filter): 初版
- **v1.0** (GIC): 合体モード固定化、空保存ガード、一括削除 UI

---

## 開発者向けメモ

- **`console_filter.js` は `comfy_boot.js` の先頭で import すること**。
  他のモジュールより先に評価される必要があります
- **`worldbook_auto_select.js` は `Lorebook_Expansion.js` より後に読まれる**
  順序に注意（`window.LorebookExpansion` に依存）
- **`char.data.extensions` の namespace は衝突しやすい**ため、
  新規追加時は必ずプレフィックスを付け、`character_store.js` 経由で保存してください
- **空保存ガード**: `/api/worldinfo/edit` は `Lorebook_Expansion.js` /
  `worldbook_auto_select.js` / `character_store.js` の 3 箇所でインターセプト
  されています。追加時は順序に注意（後から設置したものが先に呼ばれる）
