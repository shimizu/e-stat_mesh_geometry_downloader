// merge_to_geoparquet.js
// estat_shapefiles_H/ の境界Shapefile(ZIP)を1つのGeoParquetにマージする。
//
// 処理:
//   1. estat_shapefiles_H/*.zip を列挙し /vsizip 経由で直読み（解凍不要）
//   2. bin/duckdb (spatial) で全件 UNION ALL し native FORMAT PARQUET で出力
//   3. ジオメトリは CAST(ST_AsWKB(geom) AS BLOB) でプレーンBLOB化し、spatial の
//      自動 geo メタデータ生成を抑制。代わりに KV_METADATA で geo を自前指定する
//      （Python/pyarrow 不要）。crs は省略＝OGC:CRS84（BigQuery 互換）。
//
// 依存: bin/duckdb (DuckDB 1.x CLI・spatial インストール済み) のみ。

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const UNIT = "H";
const REPO = __dirname;
const SRC_DIR = path.join(REPO, `estat_shapefiles_${UNIT}`);
const OUT = path.join(REPO, `mesh_${UNIT}.parquet`);
// Windows は duckdb.exe
const DUCKDB = path.join(REPO, "bin", process.platform === "win32" ? "duckdb.exe" : "duckdb");

// GeoParquet 1.1.0 の geo メタデータ（KV_METADATA で書き込む）
// crs は省略する。GeoParquet 仕様では crs 省略＝OGC:CRS84（WGS84 経緯度）。
// BigQuery の GeoParquet ローダーは OGC:CRS84 のみ対応するため、EPSG:4612 等を
// 明示すると拒否される。元データは JGD2000(EPSG:4612) だが WGS84 との差は
// サブメートルのため、再投影せず CRS84 として出力する。
const GEO_META = JSON.stringify({
  version: "1.1.0",
  primary_column: "geometry",
  columns: {
    geometry: {
      encoding: "WKB",
      geometry_types: ["Polygon"],
      // crs 省略 ⇒ OGC:CRS84
    },
  },
});

// DuckDB に渡す（stdin経由）。SQLは複数文を含む。extraArgs で出力モード等を指定可。
function runDuckDB(sql, extraArgs = []) {
  return execFileSync(DUCKDB, extraArgs, {
    input: sql,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
}

function main() {
  if (!fs.existsSync(DUCKDB)) {
    throw new Error(`bin/duckdb が見つかりません: ${DUCKDB}`);
  }
  const zips = fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.toLowerCase().endsWith(".zip"))
    .sort();
  if (zips.length === 0) {
    throw new Error(`ZIPが見つかりません: ${SRC_DIR}`);
  }
  console.log(`${zips.length} 個のZIPをマージします`);

  // GDAL vsizip / DuckDB のパスは区切りを '/' に統一（Windowsのバックスラッシュ対策）
  const fwd = (p) => p.replace(/\\/g, "/");

  // ZIPはinner名なしの /vsizip 直読みでOK（GDALが単一shpを自動検出）
  const selects = zips
    .map((z) => `SELECT * FROM ST_Read('/vsizip/${fwd(path.join(SRC_DIR, z))}')`)
    .join("\n  UNION ALL\n  ");

  // GEO_META は二重引用符のみ → SQLのシングルクォート文字列に安全に埋め込める
  const sql = `LOAD spatial;
COPY (
  SELECT * EXCLUDE (geom), CAST(ST_AsWKB(geom) AS BLOB) AS geometry
  FROM (
  ${selects}
  )
) TO '${fwd(OUT)}' (FORMAT PARQUET, KV_METADATA {geo: '${GEO_META}'});`;

  runDuckDB(sql);

  // サマリ（-noheader -list で値のみ取得）
  const rows = runDuckDB(`SELECT count(*) FROM '${fwd(OUT)}';`, [
    "-noheader",
    "-list",
  ]).trim();
  const sizeMb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`DONE: ${OUT}  features=${rows}  size=${sizeMb}MB  crs=OGC:CRS84`);
}

main();
