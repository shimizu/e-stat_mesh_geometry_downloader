# estate-mesh

e-Stat（政府統計の総合窓口）の統計GISから、メッシュ境界データ（Shapefile）を一括ダウンロードし、1つの **GeoParquet** ファイルにマージするツールです。

- `download_estat_shapefiles.js` … e-Stat から境界 Shapefile(ZIP) を一括取得
- `merge_to_geoparquet.js` … 取得した ZIP 群を解凍せず1つの GeoParquet に結合（CRS: OGC:CRS84 / WGS84 経緯度・BigQuery 互換）

## 必要なもの

| 用途 | 必要なもの | 備考 |
| --- | --- | --- |
| 取得 (`download`) | Node.js 18+ / Playwright(Chromium) | `npm install` で導入 |
| マージ (`merge`) | Node.js 18+ / DuckDB 1.x CLI | DuckDB は単一バイナリを `bin/` に手動配置 |

> マージに **Python は不要**です（DuckDB CLI バイナリのみ）。
> システムに古い DuckDB が入っていても使いません。必ず下記の手順で `bin/` に 1.x を配置してください（古い 0.10.x は GeoParquet を書けません）。

---

## 1. 共通: リポジトリと Node 依存の準備

```bash
git clone <this-repo>
cd estate-mesh
npm install                     # playwright を導入
npx playwright install chromium # Chromium 本体を取得（初回のみ）
```

Node.js 未導入の場合は OS 別に以下で導入してください。

### Windows
- [Node.js 公式インストーラ](https://nodejs.org/)（LTS）を実行、または:
  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```

### macOS
```bash
# Homebrew
brew install node
```

### Linux
```bash
# Debian/Ubuntu 系（NodeSource など推奨）
sudo apt-get install -y nodejs npm
# もしくは nvm
# curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install --lts
```

---

## 2. DuckDB 1.x CLI の配置（マージ用）

GeoParquet 書き出しに DuckDB 1.x（spatial 拡張）を使います。OS に合ったバイナリを GitHub Releases から取得し、リポジトリ内の `bin/` に配置します。

### Windows (PowerShell)
```powershell
mkdir bin -Force
Invoke-WebRequest -Uri "https://github.com/duckdb/duckdb/releases/download/v1.1.3/duckdb_cli-windows-amd64.zip" -OutFile duckdb.zip
Expand-Archive duckdb.zip -DestinationPath bin -Force
Remove-Item duckdb.zip
# 配置結果: bin\duckdb.exe
.\bin\duckdb.exe -c "INSTALL spatial; LOAD spatial; SELECT 'ok';"
```

### macOS
```bash
mkdir -p bin
# Apple Silicon / Intel 共通 (universal)
curl -L -o duckdb.zip "https://github.com/duckdb/duckdb/releases/download/v1.1.3/duckdb_cli-osx-universal.zip"
unzip -o duckdb.zip -d bin && rm duckdb.zip
chmod +x bin/duckdb
# 初回のみ spatial 拡張を取得（要ネットワーク）
./bin/duckdb -c "INSTALL spatial; LOAD spatial; SELECT 'ok';"
```

> macOS で「開発元を確認できない」と警告される場合: `xattr -dr com.apple.quarantine bin/duckdb`

### Linux
```bash
mkdir -p bin
# x86_64 は amd64、ARM(aarch64) は duckdb_cli-linux-aarch64.zip に置き換え
curl -L -o duckdb.zip "https://github.com/duckdb/duckdb/releases/download/v1.1.3/duckdb_cli-linux-amd64.zip"
unzip -o duckdb.zip -d bin && rm duckdb.zip
chmod +x bin/duckdb
./bin/duckdb -c "INSTALL spatial; LOAD spatial; SELECT 'ok';"
```

`SELECT 'ok'` が表示されれば準備完了です。`bin/` は `.gitignore` 済みで、コミットされません。

---

## 3. 使い方

### 3-1. 境界データのダウンロード

```bash
node download_estat_shapefiles.js [UNIT]
# 例: 500mメッシュ（4次メッシュ）
node download_estat_shapefiles.js H
# npm スクリプト経由（既定 UNIT=H）
npm run download
```

- `UNIT` は e-Stat の `aggregateUnitForBoundary` 値（メッシュ単位）。
  - `H` = 4次メッシュ（500m）、`S` = 1kmメッシュ など。
- 取得した ZIP は `estat_shapefiles_<UNIT>/` に保存されます。
- 既に存在するファイルはスキップするため、中断後に再実行すると続きから取得します。
- サーバ負荷に配慮し、各ダウンロード間に 2.5〜6 秒の待機を入れています（短縮しないでください）。

### 3-2. GeoParquet へマージ

```bash
node merge_to_geoparquet.js
# npm スクリプト経由
npm run merge
```

- `estat_shapefiles_H/*.zip` を解凍せず読み込み、1ファイル `mesh_H.parquet` を生成します。
- 出力は GeoParquet 1.1.0 / WKB エンコーディング / CRS = **OGC:CRS84（WGS84 経緯度）**。
  - 元データは JGD2000(EPSG:4612) ですが、WGS84 との差はサブメートルのため再投影せず CRS84 として出力します（**BigQuery 互換**。BigQuery は OGC:CRS84 のみ受理）。
- 別のメッシュ単位を扱う場合は `merge_to_geoparquet.js` 冒頭の定数 `UNIT` を変更してください。

実行例:
```
176 個のZIPをマージします
DONE: /path/to/mesh_H.parquet  features=2006400  size=58.6MB  crs=OGC:CRS84
```

---

## 出力ファイル

| パス | 内容 | Git |
| --- | --- | --- |
| `estat_shapefiles_<UNIT>/*.zip` | ダウンロードした Shapefile | 管理外（`.gitignore`） |
| `mesh_<UNIT>.parquet` | マージ済み GeoParquet | 管理外（`.gitignore`） |
| `bin/duckdb`(`.exe`) | DuckDB 1.x CLI | 管理外（`.gitignore`） |

## 動作確認（任意）

```bash
# フィーチャ数・ジオメトリ型・CRS の確認
./bin/duckdb -c "LOAD spatial; SELECT count(*), ST_GeometryType(geometry) FROM 'mesh_H.parquet' GROUP BY 2;"
./bin/duckdb -c "SELECT key FROM parquet_kv_metadata('mesh_H.parquet') WHERE key::VARCHAR='geo';"
```

## 補足

- スクリプトのパスは内部で `/`（フォワードスラッシュ）に正規化しているため、Windows ネイティブの `node` でもそのまま動作します。
- GeoParquet は QGIS / GDAL(ogr2ogr) / GeoPandas / DuckDB など主要な地理空間ツールで読み込めます（GDAL は Parquet ドライバ入りのビルドが必要）。
