// merge_to_geoparquet.js
// 境界Shapefile(ZIP)群を1つの Parquet にマージする。対象ディレクトリは CLI 引数で指定。
//
// 出力モード:
//   既定        : GeoParquet(1.1.0)。geometry 列に geo メタデータを付与。
//                 QGIS / GeoPandas / DuckDB など一般的な GIS ツール向け。
//   --raw-wkb   : geo メタデータを付けず、WKB を BYTES 列 geom_wkb として出力。
//                 BigQuery 取り込み用。GEOGRAPHY に自動マップさせず BYTES で読み込み、
//                 BigQuery 側で ST_GEOGFROMWKB(..., planar=>TRUE, make_valid=>TRUE)
//                 により球面妥当性で修復・変換する（後述の SQL 参照）。
//
//   ※ BigQuery の GEOGRAPHY は S2(球面)判定で、平面GISでは valid な自己接触・重複頂点
//      ポリゴンを弾く。GEOS(=DuckDB ST_MakeValid 等)で valid でも BigQuery が拒否する
//      ことが多いため、修復は BigQuery 側の make_valid に任せるのが確実。
//
// 使い方:
//   node merge_to_geoparquet.js estat_shape_small_00200521_2020              # GeoParquet
//   node merge_to_geoparquet.js estat_shape_small_00200521_2020 --raw-wkb    # BigQuery用
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

オプション（括弧内はデフォルト）:
  --raw-wkb                geo メタデータ無しで WKB を BYTES 列 geom_wkb として出力
                           （BigQuery 取り込み用）。出力名は <dir名>_wkb.parquet
  --out <file>             出力 Parquet パス
  --duckdb <path>          DuckDB CLI のパス      (bin/duckdb)
  --geometry-types <list>  GeoParquet の geometry_types（既定モードのみ）。カンマ区切り。
                             (Polygon,MultiPolygon)
`);
  process.exit(opts.help || opts.h ? 0 : 1);
}

const RAW_WKB = opts["raw-wkb"] === "true" || opts.bq === "true";

// ---- パス類の解決 -------------------------------------------------------
function resolveSrcDir(arg) {
  const fromCwd = path.resolve(arg);
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromRepo = path.resolve(REPO, arg);
  if (fs.existsSync(fromRepo)) return fromRepo;
  return fromCwd;
}

const SRC_DIR = resolveSrcDir(positionals[0]);

const OUT = opts.out
  ? path.resolve(opts.out)
  : path.join(
      path.dirname(SRC_DIR),
      `${path.basename(SRC_DIR)}${RAW_WKB ? "_wkb" : ""}.parquet`
    );

const DUCKDB = opts.duckdb
  ? path.resolve(opts.duckdb)
  : path.join(REPO, "bin", process.platform === "win32" ? "duckdb.exe" : "duckdb");

const GEOM_TYPES = (opts["geometry-types"] || "Polygon,MultiPolygon")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// GeoParquet 1.1.0 の geo メタデータ（既定モードのみ使用）。
// crs 省略 ⇒ OGC:CRS84（WGS84 経緯度。BigQuery 互換）。元データ JGD2000 と WGS84 の
// 差はサブメートルのため再投影せず CRS84 として出力する。
const GEO_META = JSON.stringify({
  version: "1.1.0",
  primary_column: "geometry",
  columns: {
    geometry: { encoding: "WKB", geometry_types: GEOM_TYPES },
  },
});

function runDuckDB(sql, extraArgs = []) {
  return execFileSync(DUCKDB, extraArgs, {
    input: sql,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
}

function main() {
  if (!fs.existsSync(DUCKDB)) throw new Error(`DuckDB CLI が見つかりません: ${DUCKDB}`);
  if (!fs.existsSync(SRC_DIR)) throw new Error(`ディレクトリが見つかりません: ${SRC_DIR}`);

  const zips = fs
    .readdirSync(SRC_DIR)
    .filter((f) => f.toLowerCase().endsWith(".zip"))
    .sort();
  if (zips.length === 0) throw new Error(`ZIPが見つかりません: ${SRC_DIR}`);

  console.log(`src=${SRC_DIR}`);
  console.log(
    `${zips.length} 個のZIPをマージ (${RAW_WKB ? "raw WKB / BigQuery用" : "GeoParquet"}) -> ${OUT}`
  );

  const fwd = (p) => p.replace(/\\/g, "/");

  const selects = zips
    .map((z) => `SELECT * FROM ST_Read('/vsizip/${fwd(path.join(SRC_DIR, z))}')`)
    .join("\n  UNION ALL\n  ");

  // ジオメトリは BLOB 化して spatial の自動 geo メタデータ生成を抑制。
  const geomBlob = "CAST(ST_AsWKB(geom) AS BLOB)";

  const sql = RAW_WKB
    ? // BigQuery 用: geo メタデータ無し・列名 geom_wkb（BYTESとして読み込ませる）
      `LOAD spatial;
COPY (
  SELECT * EXCLUDE (geom), ${geomBlob} AS geom_wkb
  FROM (
  ${selects}
  )
) TO '${fwd(OUT)}' (FORMAT PARQUET);`
    : // 既定: GeoParquet（geo メタデータ付き）
      `LOAD spatial;
COPY (
  SELECT * EXCLUDE (geom), ${geomBlob} AS geometry
  FROM (
  ${selects}
  )
) TO '${fwd(OUT)}' (FORMAT PARQUET, KV_METADATA {geo: '${GEO_META}'});`;

  runDuckDB(sql);

  const rows = runDuckDB(`SELECT count(*) FROM '${fwd(OUT)}';`, [
    "-noheader",
    "-list",
  ]).trim();
  const sizeMb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);

  if (RAW_WKB) {
    console.log(
      `DONE (raw WKB): ${OUT}  features=${rows}  size=${sizeMb}MB  column=geom_wkb(BYTES)\n` +
        `  BigQuery で取り込み後、ST_GEOGFROMWKB(geom_wkb, planar=>TRUE, make_valid=>TRUE) で変換してください。`
    );
  } else {
    console.log(
      `DONE: ${OUT}  features=${rows}  size=${sizeMb}MB  crs=OGC:CRS84  ` +
        `geometry_types=[${GEOM_TYPES.join(", ")}]`
    );
  }
}

main();