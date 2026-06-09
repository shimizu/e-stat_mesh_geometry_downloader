# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

e-Stat（政府統計の総合窓口）の地図データ（統計GIS）から、メッシュ境界データ（Shapefile）を一括ダウンロードし、1つの GeoParquet にマージするツール群。`download_estat_shapefiles.js`（取得）と `merge_to_geoparquet.js`（マージ）の2スクリプト（Node.js）で構成される。

## コマンド

```bash
npm install                       # 依存関係（playwright）のインストール
npx playwright install chromium   # 初回のみ：Chromium ブラウザ本体を取得
node download_estat_shapefiles.js [UNIT]  # スクレイパー実行（UNIT 既定は H）
```

`UNIT` は e-Stat の `aggregateUnitForBoundary` 値（メッシュ単位）。例：`H`=4次メッシュ（500m）、`S`=1kmメッシュ。`node download_estat_shapefiles.js H` のように指定する。

```bash
# ダウンロード済みShapefile(ZIP)を1つのGeoParquetにマージ
node merge_to_geoparquet.js   # estat_shapefiles_H/*.zip → mesh_H.parquet
```

マージに必要なのは `bin/duckdb`（DuckDB 1.x CLI・spatial拡張）**のみ**（Python不要）。`bin/duckdb` は GitHub Releases から取得してリポジトリ内 `bin/` に配置する（システムの `/usr/bin/duckdb`=0.10.2 は GeoParquet を書けないため使わない）。

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

## マージ（`merge_to_geoparquet.js`）

`estat_shapefiles_H/*.zip` を1つの GeoParquet（`mesh_H.parquet`）に結合する処理フロー（Node.js から `bin/duckdb` を `child_process.execFileSync` で呼ぶ）：

1. `fs.readdirSync` で `*.zip` を列挙し `/vsizip/<abs>/<zip>` を構築（**ZIPは解凍せず** GDAL の vsizip で直読み。inner名は不要＝GDALが単一shpを自動検出）。
2. 全ZIPを `ST_Read(...)` の `UNION ALL` で結合。ジオメトリは `CAST(ST_AsWKB(geom) AS BLOB)` で**プレーンBLOB**に変換し（spatial の自動 `geo` メタデータ生成を抑制）、`COPY ... (FORMAT PARQUET, KV_METADATA {geo: '...'})` で出力。
3. `geo` メタデータ（GeoParquet 1.1.0 / WKB / CRS）は **JS 側で組み立てて KV_METADATA に渡す**。CRS は EPSG:4612（JGD2000）の PROJJSON を**スクリプト内の定数** `PROJJSON_4612` に保持（実行時の gdalsrsinfo / Python 不要）。

### 重要な前提・制約
- **GDAL 3.4.3 / DuckDB 0.10.2 は GeoParquet を書けない**。GDAL は Parquet ドライバ非搭載、DuckDB 0.10.2 は `geo` メタデータを出力しない。そのため DuckDB 1.x（`bin/duckdb`）が必須。
- **ジオメトリは必ず `CAST(... AS BLOB)` でプレーンBLOB化する**こと。`ST_AsWKB` の戻り値（WKB_BLOB型）のままだと spatial が `geo` を自動生成し、`KV_METADATA` の自前 `geo` と**重複（2個）**して不正になる。
- CRS は DuckDB の `GEOMETRY` 型が保持しないため、上記のとおり `geo` メタデータに PROJJSON を自前で埋め込む方式で付与する。
- 入力スキーマは全ファイル統一（`KEY_CODE, MESH1_ID〜MESH4_ID, OBJ_ID, geom`）。別メッシュ単位を扱う場合は `merge_to_geoparquet.js` 冒頭の `UNIT` を変更する。
