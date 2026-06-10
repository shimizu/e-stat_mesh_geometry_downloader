// download_estat_shape_small_area.js
//
// e-Stat 統計地理情報システムの「小地域（町丁・字等）」境界 Shapefile を
// 都道府県単位で一括ダウンロードするスクリプト。
//
// ■方式
//   境界データダウンロードのページは SPA で、都道府県一覧もダウンロード用
//   テーブルも JS が API から取得して描画する（サーバ HTML には無い）。
//   一方、実ダウンロードは次の直URLで取得でき、セッション不要の素の GET で
//   落ちることを確認済み:
//     https://www.e-stat.go.jp/gis/statmap-search/data
//        ?dlserveyId=<dlserveyId>&code=<都道府県コード>
//        &coordSys=<1|2>&format=shape&downloadType=5&datum=<2000|2011>
//   町丁・字等は code=01〜47（都道府県）で1ファイル、dlserveyId の先頭は "A"。
//   よってページをスクレイプせず、code を直接生成して取得する。
//
// ■使い方
//   node download_estat_shape_small_area.js                       # 2020全国
//   node download_estat_shape_small_area.js --codes 10,11,13      # 群馬・埼玉・東京のみ
//   node download_estat_shape_small_area.js --year 2015 --dlserveyId A002005212015
//   node download_estat_shape_small_area.js --help
//
// 依存なし（Node 18+ の標準 fetch を使用）。

const fs = require("fs");
const path = require("path");

const DATA_URL = "https://www.e-stat.go.jp/gis/statmap-search/data";

const SLEEP_MIN = 2500;
const SLEEP_MAX = 6000;

// curl が弾かれる事例があるためブラウザ相当のヘッダを付与
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://www.e-stat.go.jp/gis/statmap-search?type=2",
  Accept: "*/*",
};

// ---- CLI 引数のパース ---------------------------------------------------
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith("--")) continue;
    a = a.slice(2);
    const eq = a.indexOf("=");
    if (eq >= 0) {
      opts[a.slice(0, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      opts[a] = argv[++i];
    } else {
      opts[a] = "true";
    }
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`
使い方:
  node download_estat_shape_small_area.js [options]

オプション（括弧内はデフォルト）:
  --year        <YYYY>       調査年 toukeiYear                 (2020)
  --toukeiCode  <code>       統計コード                        (00200521 = 国勢調査)
  --dlserveyId  <id>         DL用 dlserveyId。未指定なら A+toukeiCode+year を自動生成
  --datum       <2000|2011>  測地系（JGD2000 / JGD2011）       (2000)
  --coordsys    <1|2>        1=緯度経度, 2=平面直角座標         (1)
  --codes       <spec>       取得する地域コード。カンマ/範囲可  (1-47 = 全都道府県)
                             例: "13" / "10,11,13" / "1-9,40-47"
  --out         <dir>        出力ディレクトリ

注意:
  dlserveyId の先頭文字（A / B / ...）は年度・集計単位で変わります。
  町丁・字等(小地域)は "A"、市区町村/基本単位区などは別系統です。
  年を変えてうまく落ちない場合は、e-Stat の実ページで1件ダウンロードして
  URL の dlserveyId を確認し、--dlserveyId で明示指定してください。
`);
  process.exit(0);
}

const TOUKEI_CODE = args.toukeiCode || "00200521";
const YEAR = String(args.year || "2020");
const DATUM = String(args.datum || "2000");
const COORDSYS = String(args.coordsys || "1");

// 町丁・字等の DL は dlserveyId 先頭が "A"（2020 で検証済み）
const DLSERVEY_ID = args.dlserveyId || `A${TOUKEI_CODE}${YEAR}`;
if (!args.dlserveyId && YEAR !== "2020") {
  console.warn(
    `[warn] dlserveyId を自動生成しました: ${DLSERVEY_ID}\n` +
      `       年度により先頭文字が異なる場合があります。0件/失敗が続くときは\n` +
      `       実ページの DL URL から dlserveyId をコピーして --dlserveyId で指定してください。`
  );
}

// "1-47" / "10,11,13" / "01,1-9" などを 2桁ゼロ詰め配列に展開
function parseCodes(spec) {
  const out = new Set();
  for (const part of String(spec).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = Number(m[1]);
      let b = Number(m[2]);
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) out.add(String(n).padStart(2, "0"));
    } else {
      out.add(part.padStart(2, "0")); // 5桁の市区町村コード等はそのまま
    }
  }
  return [...out].sort();
}

const CODES = parseCodes(args.codes || "1-47");

const OUT_DIR =
  args.out ||
  path.resolve(process.cwd(), `estat_shape_small_${TOUKEI_CODE}_${YEAR}`);

// ---- ユーティリティ -----------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const politeSleep = () =>
  sleep(SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN));

const safeName = (name) => name.replace(/[\\/:*?"<>|]/g, "_");

function filenameFromDisposition(disposition, fallback) {
  if (disposition) {
    const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (star) {
      try {
        return decodeURIComponent(star[1]);
      } catch {
        return star[1];
      }
    }
    const plain = disposition.match(/filename="?([^";]+)"?/i);
    if (plain) return plain[1];
  }
  return fallback;
}

// 先頭2バイトが "PK"(0x50 0x4B) なら ZIP とみなす
const looksLikeZip = (buf) =>
  buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;

function dlUrl(code) {
  const p = new URLSearchParams({
    dlserveyId: DLSERVEY_ID,
    code,
    coordSys: COORDSYS, // DL側は大文字 S
    format: "shape",
    downloadType: "5",
    datum: DATUM,
  });
  return `${DATA_URL}?${p.toString()}`;
}

// ---- メイン -------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`dlserveyId=${DLSERVEY_ID}  datum=${DATUM}  coordSys=${COORDSYS}`);
  console.log(`codes=${CODES.length}件  OUT_DIR=${OUT_DIR}\n`);

  let total = 0;

  for (const code of CODES) {
    // 既存スキップ: 保存名は "<code>__<元名>"。区切り付き前方一致で誤爆を防ぐ。
    const existing = fs.readdirSync(OUT_DIR);
    const hit = existing.find((f) => f.startsWith(`${code}__`));
    if (hit) {
      console.log(`skip existing: ${hit}`);
      continue;
    }

    const url = dlUrl(code);
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
      if (!res.ok) {
        console.warn(`HTTP ${res.status}  code=${code}`);
        await politeSleep();
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (!looksLikeZip(buf)) {
        console.warn(
          `code=${code}: ZIP ではない応答 (size=${buf.length})。` +
            `dlserveyId/code/年度を確認してください。`
        );
        await politeSleep();
        continue;
      }

      const origName = safeName(
        filenameFromDisposition(
          res.headers.get("content-disposition"),
          `${code}.zip`
        )
      );
      const filename = `${code}__${origName}`;
      const savePath = path.join(OUT_DIR, filename);

      fs.writeFileSync(savePath, buf);
      total++;
      console.log(`saved: ${filename} (${buf.length} bytes)`);

      await politeSleep();
    } catch (err) {
      console.warn(`error code=${code}: ${err.message}`);
      await politeSleep();
    }
  }

  console.log(`\nDONE. total downloads: ${total}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});