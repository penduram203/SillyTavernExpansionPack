# SillyTavern Expansion Pack

複数の SillyTavern 拡張機能を 1 つのリポジトリに統合したパッケージです。
SillyTavern の「拡張機能をインストール」から本リポジトリの URL を指定するだけで、
含まれるすべての拡張がまとめてインストール・更新されます。

## 同梱拡張一覧

### Chat Window On/Off

チャットウインドウ（`#chat`, `#form_sheld`, `#sheldheader`）の表示・非表示（透過）を
左下の 💡 ボタンでワンクリック切り替えできる拡張機能です。

- 画面左下に表示される 💡 ボタンをクリックすると、チャットウィンドウの表示/非表示が切り替わります
- 選択した状態はブラウザに保存され、次回起動時にも復元されます

### Right Nav Panel Customizer (右ナビパネル改変)

SillyTavern の右側「キャラクター管理」パネルのキャラクター一覧を、
グリッド表示・大きめのサムネイル表示にカスタムする拡張機能です。

- 各キャラクターの `<name>_ext.json` 内の `image_display_extension.thumbnail`
  に指定された画像があれば、一覧のアバター画像をその画像に差し替えます
- `thumbnail` が未設定、または `_ext.json` 自体が存在しない場合は、
  通常のアバター画像がそのまま表示されます

**依存関係**: この JSON ファイル形式は `stj_editor` 拡張機能で作成することを想定しています。

### STJ Character Exporter (stj_editor)

キャラクターの「キーワード → 表示画像」の対応関係を JSON 形式で作成・出力する
SillyTavern 拡張機能です。出力された JSON は `image-display` および `right_nav_kai`
拡張機能から読み込まれます。

**使い方:**

1. キャラクター作成/編集パネルを開くと「JSONデータ編集」ボタンが表示されます
2. デフォルト画像・サムネイル画像・キーワードごとの画像を設定します
   （画像ファイル名は拡張子なしで入力すると自動検出されます。カンマ区切りで
   複数指定するとランダム表示になります）
3. 「セーブ」でブラウザに下書きを保存、「JSON出力」で完成した JSON ファイルを
   ダウンロードします

**出力後の手動配置が必要です（重要）:**

「JSON出力」でダウンロードされる `<キャラ名>_ext.json` は、**サーバーの
`addchara/<キャラ名>/<キャラ名>_ext.json` に手動で配置する必要があります。**
この拡張機能はブラウザ上でファイルをダウンロードするだけで、サーバーへの
自動アップロードは行いません。

同様に、`addchara/default.png`（全キャラクター共通のフォールバック画像）も
初回セットアップ時に手動で配置してください。

### Text Styling Extension

チャット内テキストの見た目（`<p>` `<q>` `<em>` タグごとの文字サイズ・太さ・色・
縁取り・行間・透過度）と、チャットウインドウ自体の背景透過度を細かく調整できる
拡張機能です。

**主な機能:**

- `<p>` / `<q>` / `<em>` タグごとに独立したスタイル設定（有効/無効、サイズ、太さ、
  文字色、縁取り色・幅、行間、透過度）
- チャットウインドウの背景透過度調整
- チャットウインドウの位置プリセット（中央寄せ／左右分割／手動）ボタン
- 設定パネルの表示/非表示切替（左下の T アイコン）

### Image Display Extension

チャットのメッセージ本文に含まれるキーワードに応じて、対応する画像を表示する
ドラッグ&リサイズ可能なウインドウを SillyTavern 画面上に追加します。

**主な機能:**

- ユーザー発言／AI 発言のどちらを監視するか切り替え可能（画面左下「UT」「AI」ボタン）
- AI メッセージのストリーミング生成中は、1 秒間テキストが変化しなくなるまで
  画像更新を遅延させ、生成途中の文章での誤爆を防止
- キーワード条件は `and` / `or` / 括弧によるグループ化に対応
- 一致した画像が配列の場合はランダムに 1 つ選択（複数バリエーション対応）
- 通常表示／最大化／左半分表示の 3 モード、背景色変更、位置・サイズの保存

**データソース:**

キーワードと画像の対応表は、`SillyTavern.getContext()` 経由でキャラクターカードの
拡張データを見るか、無ければ `addchara/<キャラ名>/<キャラ名>_ext.json` を fetch します。
この JSON は `stj_editor` 拡張機能で作成・出力できます。

**前提となる手動セットアップ:**

`addchara/default.png`（フォールバック用デフォルト画像）を、SillyTavern サーバーの
`public/addchara/default.png` に一度だけ手動で配置してください。
拡張機能の自動更新ではこのアセットは配置されません。

### Lorebook Expansion

SillyTavern のロアブック編集画面に **Img_prompt** と **choices** の 2 つのカスタム
フィールドを追加する拡張機能です。

**機能:**

- ロアブックの各エントリに以下を追加:
  - **Img_prompt** — 画像生成プロンプト (3行分のテキストエリア)
  - **choices** — 複数の選択肢 (3桁番号 + 文言 のペア、追加/削除可能)
- ユーザーが選択肢番号を入力して AI が応答すると、
  その番号に対応するロアブックエントリの choices を
  **応答本文の末尾に自動で番号と文言を表示**する
- Img_prompt は別拡張 `generate_image_controller` の `gic_lorebook.js` から
  読み取られ、画像生成プロンプトとして使用される

**データ保存先:**

データは以下の 2 箇所に保存されます:

- **一次**: `extension_settings.lorebook_expansion.data[worldName][uid]`
  — ST が自動永続化。ワールド情報の保存サイクルに影響されない
- **二次**: `entry.extensions.lorebook_expansion` (best effort ミラー)
  — ロアブック JSON の可搬性のため

読込時は一次を優先し、一次が無ければ二次から移行（マイグレーション）します。

### Generate Image Controller (GIC)

ロアブック（Lorebook）の選択肢番号をトリガーに、**Stable Diffusion で画像を自動生成**し、
その画像を SillyTavern の背景として自動的に表示する統合コントローラ拡張です。
SillyTavern 公式ギャラリーの操作性を強化する機能（ページネーション・一括削除・
ウォームアップ）も含みます。

## 主な機能

### 1. ロアブック駆動の画像自動生成（gic_lorebook.js）

- ユーザーが **3桁の選択肢番号**（例: `001`, `002`）を送信すると、
  その番号に対応するロアブックエントリの `Img_prompt` を読み取り、
  `/sd` スラッシュコマンド経由で Stable Diffusion に画像生成を依頼します
- `Img_prompt` の取得元（優先順位）:
  1. `extension_settings.lorebook_expansion.data[worldName][uid].img_prompt`
     （**Lorebook_Expansion** 拡張の一次ストア）
  2. `entry.extensions.lorebook_expansion.img_prompt`
     （ロアブック JSON へのミラー）
  3. `entry.extensions.gic_prompt`（旧形式）
  4. `entry.content` 内の `[GIC_IMG: ...]` / `[IMG: ...]`（最古の形式）
- AI メッセージ本文から `[GIC_IMG: ...]` タグを自動除去し、
  プロンプトが本文に漏れないようにします
- 手動実行用スラッシュコマンド **`/gic-sd`** と、
  診断用 **`/gic-test`** を提供

### 2. 背景画像の自動切り替え（gic.js）

- 生成された画像を **Image Display Extension** の API 経由で
  背景に強制表示（override モード）
- 画面左端の **GIC トグルボタン**（「背景生成」⇄「事前設定」）で
  以下の2モードをワンクリック切替:
  - **背景生成モード**: 最新の生成画像を背景に固定表示
  - **事前設定モード**: キーワードマッチによる通常の画像表示
- 起動時に永続化された override URL の存在を確認し、
  削除済みの画像が指定されていた場合は自動的に状態を解除

### 3. 公式ギャラリーの強化

- 画面左下の **🎨 ボタン** から SillyTavern 公式ギャラリーを開く
- ギャラリー起動前に **自動ウォームアップ**（プリロード）を実行し、
  初回クリック時の遅延を低減
- キャラクター変更時にギャラリーを再準備
- **ページネーション**（ページ番号ボタン）を独自 UI に置き換え
- **一括削除機能**:
  1. ギャラリー内の 🗑 アイコンをクリック → 削除モード開始
  2. 削除したい画像をクリックで選択（赤枠＋赤フィルターで強調）
  3. 「一括削除」ボタン → 確認 → サーバー側の画像を削除
  4. 削除後、ギャラリーを自動で再構築（UI 状態を保持）
- 削除された画像が `lastGeneratedImageUrl` と一致する場合、
  参照も自動クリア

### 4. UI 制御

- Text_styling の設定パネルが開いている間は GIC ボタンを非表示
- ギャラリー表示中は GIC ボタン・ギャラリーボタンを非表示
- ステータスメッセージ（「ギャラリーを読み込み中です…」「読み込み完了」等）を
  🎨 ボタンの左側に表示

## データソース

| 用途 | 参照先 |
|---|---|
| 画像生成プロンプト | **Lorebook_Expansion** の一次ストア、または ロアブックエントリの `extensions` |
| 背景画像表示 | **Image Display Extension** の `window.ImageDisplayExtension` API |
| ギャラリー | SillyTavern 公式 `gallery` 拡張 |
| Stable Diffusion | SillyTavern 標準の `/sd` スラッシュコマンド |

## 依存関係

この拡張は以下の拡張機能と連携して動作します。
本パック（SillyTavernExpansionPack）にはすべて同梱されています:

- **Lorebook_Expansion** — `Img_prompt` / `choices` の一次ストアを提供
- **Image Display Extension** — 背景画像表示 API を提供
- **stj_editor** — ロアブック JSON を作成・出力する側（開発時）

## 前提となる手動セットアップ

Stable Diffusion（または ComfyUI）を別途起動し、
SillyTavern の「拡張機能設定 → Stable Diffusion」で接続先を設定してください。
本拡張は `/sd` スラッシュコマンドを発行するだけで、SD サーバー自体は起動しません。

## 使い方

### 画像生成の自動化

1. ロアブックの各エントリに **Lorebook_Expansion** で `Img_prompt` を設定
2. 同じエントリに `choices`（選択肢番号 + 文言）を設定
3. AI の応答末尾に選択肢が表示されたら、番号（例: `001`）を送信
4. `Img_prompt` に基づいて `/sd` が実行され、生成画像が背景に表示

### 手動実行

チャット入力欄で以下を実行:

- `/gic-sd` — 直前のユーザーメッセージから選択肢番号を抽出して画像生成
- `/gic-test` — 現在のロアブック/ストア状態を診断表示

### ギャラリー操作

- 画面左下の 🎨 ボタン → 公式ギャラリーを開く
- ギャラリー内の 🗑 アイコン → 削除モード
- 画像をクリックで選択 → 「一括削除」 → 確認

## 公開 API

デバッグ・外部連携用に以下のグローバル API を公開しています:

```js
// gic_lorebook.js
window.GicLorebook = {
    getSettings, setSettings,
    processChoice, extractChoiceNumber,
    extractPromptFromEntry, getLexImgPrompt,
    loadWorldInfoEntries, findEntryByChoice, getEntryKeys,
    stripGicImgFromDom, executeSd,
    resetDedup,
};

// gic.js
window.GicDumpGallery = function () { /* ギャラリー DOM 構造をダンプ */ };

## インストール方法

1. SillyTavern の拡張機能パネルを開く
2. 「拡張機能をインストール」をクリック
3. このリポジトリの URL を貼り付けて保存

## 更新方法

拡張機能管理画面から更新するか、`auto_update` が有効なため ST 本体の更新に追従します。

## ディレクトリ構成
