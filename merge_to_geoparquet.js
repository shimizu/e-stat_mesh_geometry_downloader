// merge_to_geoparquet.js
// 境界Shapefile(ZIP)群を1つのGeoParquetにマージする。
// 対象ディレクトリは CLI 引数で指定する。
//
// 処理:
//   1. <src-dir>/*.zip を列挙し /vsizip 経由で直読み（解凍不要）
//   2. bin/duckdb (spatial) で全件 UNION ALL し native FORMAT PARQUET で出力
//   3. ジオメトリは CAST(ST_AsWKB(geom) AS BLOB) でプレーンBLOB化し、spatial の
//      自動 geo メタデータ生成を抑制。代わりに KV_METADATA で geo を自前指定する
//      （Python/pyarrow 不要）。crs は省略＝OGC:CRS84（BigQuery 互換）。
//
// 使い方:
//   node merge_to_geoparquet.js estat_shape_A_00200521_2020
//   node merge_to_geoparquet.js ./estat_shapefiles_E --geometry-types Polygon
//   node merge_to_geoparquet.js <dir> --out out.parquet --duckdb /path/to/duckdb
//   node merge_to_geoparquet.js --help
//
// 依存: bin/duckdb (DuckDB 1.x CLI・spatial インストール済み) のみ。

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = __dirname;

// ---- CLI 引数のパース ---------------------------------------------------
function parseArgs(argv) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith("--")) {
      a = a.slice(2);
      const eq = a.indexOf("=");
      if (eq >= 0) {
        opts[a.slice(0, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        opts[a] = argv[++i];
      } else {
        opts[a] = "true";
      }
    } else {
      positionals.push(a);
    }
  }
  return { opts, positionals };
}

const { opts, positionals } = parseArgs(process.argv.slice(2));

if (opts.help || opts.h || positionals.length === 0) {
  console.log(`
使い方:
  node merge_to_geoparquet.js <src-dir> [options]

引数:
  <src-dir>                マージ対象の ZIP が入ったディレクトリ（必須）
                           相対パスは cwd → スクリプト位置 の順で解決します。

オプション（括弧内はデフォルト）:
  --out <file>             出力 GeoParquet パス
                             (<src-dir>と同じ階層に <dir名>.parquet)
  --duckdb <path>          DuckDB CLI のパス      (bin/duckdb)
  --geometry-types <list>  GeoParquet の geometry_types。カンマ区切り。
                             (Polygon,MultiPolygon)
                           ※メッシュ等 Polygon のみなら "Polygon" を指定。
`);
  process.exit(opts.help || opts.h ? 0 : 1);
}

// ---- パス類の解決 -------------------------------------------------------
function resolveSrcDir(arg) {
  const fromCwd = path.resolve(arg);
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromRepo = path.resolve(REPO, arg); // スクリプト隣のディレクトリも探す
  if (fs.existsSync(fromRepo)) return fromRepo;
  return fromCwd; // 見つからなければ後段でエラーにする
}

const SRC_DIR = resolveSrcDir(positionals[0]);

const OUT = opts.out
  ? path.resolve(opts.out)
  : path.join(path.dirname(SRC_DIR), `${path.basename(SRC_DIR)}.parquet`);

const DUCKDB = opts.duckdb
  ? path.resolve(opts.duckdb)
  : path.join(REPO, "bin", process.platform === "win32" ? "duckdb.exe" : "duckdb");

// geometry_types はメッシュ=Polygon、小地域=Polygon/MultiPolygon 混在を想定し
// 既定で両方を宣言。正確に絞りたければ --geometry-types で上書きする。
const GEOM_TYPES = (opts["geometry-types"] || "Polygon,MultiPolygon")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
      geometry_types: GEOM_TYPES,
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
    throw new Error(`DuckDB CLI が見つかりません: ${DUCKDB}`);
  }
  if (!fs.existsSync(SRC_DIR)) {
    throw new Error(`ディレクトリが見つかりません: ${SRC_DIR}`);
  }

  const zips = fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.toLowerCase().endsWith(".zip"))
    .sort();
  if (zips.length === 0) {
    throw new Error(`ZIPが見つかりません: ${SRC_DIR}`);
  }
  console.log(`src=${SRC_DIR}`);
  console.log(`${zips.length} 個のZIPをマージします -> ${OUT}`);

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
  console.log(
    `DONE: ${OUT}  features=${rows}  size=${sizeMb}MB  ` +
      `crs=OGC:CRS84  geometry_types=[${GEOM_TYPES.join(", ")}]`
  );
}

main();