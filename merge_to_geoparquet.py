#!/usr/bin/env python3
"""estat_shapefiles_H/ の境界Shapefile(ZIP)を1つのGeoParquetにマージする。

処理:
  1. estat_shapefiles_H/*.zip を列挙し、各ZIP内の .shp を /vsizip 経由で読む
  2. bin/duckdb (spatial) で全件を UNION ALL し、native FORMAT PARQUET で出力
     （GeoParquet 1.1.0 / WKB エンコーディング）
  3. DuckDBのGEOMETRY型はCRS非保持のため、geoメタデータに EPSG:4612 の
     PROJJSON を pyarrow で注入する

前提: bin/duckdb (1.x) 配置済み・spatial インストール済み、pyarrow / gdalsrsinfo 利用可。
"""
import glob
import json
import os
import subprocess
import sys
import zipfile

REPO = os.path.dirname(os.path.abspath(__file__))
UNIT = "H"
EPSG = 4612

SRC_DIR = os.path.join(REPO, f"estat_shapefiles_{UNIT}")
OUT = os.path.join(REPO, f"mesh_{UNIT}.parquet")
TMP = os.path.join(REPO, f".mesh_{UNIT}.raw.parquet")
DUCKDB = os.path.join(REPO, "bin", "duckdb")


def inner_shp(zip_path):
    """ZIP内の .shp エントリ名を返す（inner名をハードコードしない）。"""
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if name.lower().endswith(".shp"):
                return name
    raise RuntimeError(f"no .shp entry in {zip_path}")


def main():
    zips = sorted(glob.glob(os.path.join(SRC_DIR, "*.zip")))
    if not zips:
        sys.exit(f"ZIPが見つかりません: {SRC_DIR}")
    print(f"{len(zips)} 個のZIPをマージします")

    # 1. + 2. DuckDBで全件UNION ALL → GeoParquet(WKB)
    selects = [
        f"SELECT * FROM ST_Read('/vsizip/{z}/{inner_shp(z)}')" for z in zips
    ]
    sql = (
        "LOAD spatial;\n"
        "COPY (\n" + "\n  UNION ALL\n".join(selects) + "\n) "
        f"TO '{TMP}' (FORMAT PARQUET);\n"
    )
    subprocess.run([DUCKDB], input=sql, text=True, check=True)

    # 3. geoメタデータに EPSG:4612 のCRS(PROJJSON)を注入
    import pyarrow.parquet as pq

    projjson = json.loads(
        subprocess.check_output(["gdalsrsinfo", "-o", "PROJJSON", f"EPSG:{EPSG}"])
    )
    table = pq.read_table(TMP)
    meta = dict(table.schema.metadata or {})
    geo = json.loads(meta[b"geo"])
    geo["columns"][geo["primary_column"]]["crs"] = projjson
    meta[b"geo"] = json.dumps(geo).encode()
    pq.write_table(table.replace_schema_metadata(meta), OUT)
    os.remove(TMP)

    info = pq.read_metadata(OUT)
    size_mb = os.path.getsize(OUT) / 1024 / 1024
    print(f"DONE: {OUT}  features={info.num_rows}  size={size_mb:.1f}MB  crs=EPSG:{EPSG}")


if __name__ == "__main__":
    main()
