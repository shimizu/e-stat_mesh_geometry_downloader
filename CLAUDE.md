# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

e-Stat（政府統計の総合窓口）の地図データ（統計GIS）から、1kmメッシュの境界データ（Shapefile）を一括ダウンロードするスクレイパー。現状コードは単一スクリプト `download_estat_shapefiles.js` のみで構成される。

## コマンド

```bash
npm install                       # 依存関係（playwright）のインストール
npx playwright install chromium   # 初回のみ：Chromium ブラウザ本体を取得
node download_estat_shapefiles.js [UNIT]  # スクレイパー実行（UNIT 既定は H）
```

`UNIT` は e-Stat の `aggregateUnitForBoundary` 値（メッシュ単位）。例：`H`=4次メッシュ（500m）、`S`=1kmメッシュ。`node download_estat_shapefiles.js H` のように指定する。

テストは未設定（`npm test` はエラーで終了する）。

## アーキテクチャ

`download_estat_shapefiles.js` の処理フロー：

1. e-Stat の統計GIS検索ページ（`BASE_URL` = `statmap-search`）を、`BASE_PARAMS`（`aggregateUnitForBoundary=UNIT` メッシュ単位 / `coordsys=1` 世界測地系緯度経度 / `format=shape` Shapefile）と `page` 番号を組み合わせた URL で 1 ページずつ巡回する。
2. 各ページを `networkidle` まで描画後、`page.evaluate()` で `a[href*="downloadType=5"]`（境界Shapefileの直リンク）の `href` を収集する。定義書（`downloadType=1`）は対象外。
3. 収集した各 href を `context.request.get()` で取得し（ページと同一セッションのCookieを共有）、ファイル名は `content-disposition`（`filename*=UTF-8''...`）から `filenameFromDisposition()` で取り出して `safeName()` でサニタイズ、`OUT_DIR`（= `estat_shapefiles_${UNIT}/`）に `fs.writeFileSync` で保存する。既存ファイルは上書きせずスキップ。
4. DLリンクが 0 件になったページで巡回を終了する（`MAX_PAGES=999` が上限）。

### 重要な前提・挙動

- **headless 実行**：`chromium.launch({ headless: true })`。ブラウザ本体は `npx playwright install` が必要。
- **サーバ負荷への配慮**：各ダウンロード・各ページ間で `politeSleep()`（2.5〜6秒のランダムウェイト）を必ず挟む。e-Stat への高頻度アクセスを避けるため、このウェイトを短縮・削除しないこと。
- **冪等性**：保存先に同名ファイルが存在すれば再ダウンロードしない。中断後の再実行で続きから取得できる。
- 出力先は `estat_shapefiles_${UNIT}/`（メッシュ単位ごとに分離）。別途存在する `1km/` ディレクトリは git 管理外のデータ置き場（現状は空）。

### 調整ポイント

メッシュ単位は CLI 引数 `UNIT` で切替える。それ以外の取得条件を変える場合はファイル冒頭の定数を編集する：`BASE_PARAMS`（座標系・出力形式など e-Stat のクエリパラメータ）、`SLEEP_MIN/MAX`（ウェイト）、`MAX_PAGES`（最大ページ数）。
