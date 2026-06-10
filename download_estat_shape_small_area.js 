// download_estat_shape_small_area.js
//
// e-Stat 統計地理情報システムの「小地域」境界データ（Shapefile）を
// 都道府県単位などで一括ダウンロードするスクリプト。
//
// 元にしたリスト画面 URL（2020年 国勢調査 小地域・世界測地系緯度経度 JGD2000）:
//   https://www.e-stat.go.jp/gis/statmap-search?page=1&type=2
//     &aggregateUnitForBoundary=A&toukeiCode=00200521&toukeiYear=2020
//     &serveyId=B002005212020&datum=2000&coordsys=1&format=shape
//
// 仕組み:
//   リスト画面を Playwright で開き、描画される境界 Shapefile の
//   ダウンロードリンク <a href="...&downloadType=5"> を抽出して順に取得する。
//   実 DL リンクの dlserveyId / code は e-Stat 側が生成するため、
//   こちらで A/B プレフィックスの使い分けを解決する必要はない。
//
// 使い方:
//   node download_estat_shape_small_area.js              # デフォルト(2020)
//   node download_estat_shape_small_area.js --year 2015 --serveyId A002005212015
//   node download_estat_shape_small_area.js --help

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE_URL = "https://www.e-stat.go.jp/gis/statmap-search";

const SLEEP_MIN = 2500;
const SLEEP_MAX = 6000;

// ---- CLI 引数のパース ---------------------------------------------------
//   --key value / --key=value / --flag いずれも可
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
  --year        <YYYY>       調査年 toukeiYear              (2020)
  --toukeiCode  <code>       統計コード                    (00200521 = 国勢調査)
  --serveyId    <id>         serveyId。未指定なら B+toukeiCode+year を自動生成
  --datum       <2000|2011>  測地系（JGD2000 / JGD2011）   (2000)
  --coordsys    <1|2>        1=緯度経度, 2=平面直角座標     (1)
  --unit        <A|...>      aggregateUnitForBoundary      (A)
  --out         <dir>        出力ディレクトリ
  --max-pages   <n>          最大ページ数（保険）          (999)

注意:
  serveyId の先頭文字（A / B / ...）は年度・集計単位によって変わります。
  年を変えるときは、e-Stat の実ページを開いてアドレスバーの serveyId を
  コピーし、--serveyId で明示指定するのが確実です。
`);
  process.exit(0);
}

const TOUKEI_CODE = args.toukeiCode || "00200521";
const YEAR = String(args.year || "2020");
const DATUM = String(args.datum || "2000");
const COORDSYS = String(args.coordsys || "1");
const UNIT = args.unit || "A";

// serveyId 未指定なら自動生成。デフォルト(2020)は提示 URL に合わせ先頭 "B"。
const SERVEY_ID = args.serveyId || `B${TOUKEI_CODE}${YEAR}`;
if (!args.serveyId && YEAR !== "2020") {
  console.warn(
    `[warn] serveyId を自動生成しました: ${SERVEY_ID}\n` +
      `       年度により先頭文字が異なる場合があります。リンクが 0 件のときは\n` +
      `       e-Stat の URL から serveyId をコピーして --serveyId で指定してください。`
  );
}

const OUT_DIR =
  args.out ||
  path.resolve(__dirname, `estat_shape_${UNIT}_${TOUKEI_CODE}_${YEAR}`);

const MAX_PAGES = Number(args["max-pages"] || 999);

const BASE_PARAMS = {
  type: "2",
  aggregateUnitForBoundary: UNIT,
  toukeiCode: TOUKEI_CODE,
  toukeiYear: YEAR,
  serveyId: SERVEY_ID,
  datum: DATUM,
  coordsys: COORDSYS, // リスト画面は小文字 coordsys（DLリンク側は coordSys）
  format: "shape",
};

// ---- ユーティリティ -----------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const politeSleep = () =>
  sleep(SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN));

function makeUrl(pageNo) {
  const params = new URLSearchParams({ page: String(pageNo), ...BASE_PARAMS });
  return `${BASE_URL}?${params.toString()}`;
}

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

// 先頭2バイトが "PK"（0x50 0x4B）なら ZIP とみなす
const looksLikeZip = (buf) =>
  buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;

async function gotoWithRetry(page, url, tries = 3) {
  for (let t = 1; t <= tries; t++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return true;
    } catch (err) {
      console.warn(`goto failed (${t}/${tries}): ${err.message}`);
      if (t === tries) return false;
      await politeSleep();
    }
  }
  return false;
}

// ---- メイン -------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`serveyId=${SERVEY_ID}  unit=${UNIT}  year=${YEAR}  datum=${DATUM}`);
  console.log(`OUT_DIR=${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  let totalDownloads = 0;

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const url = makeUrl(pageNo);
    console.log(`\n=== page ${pageNo}: ${url}`);

    const ok = await gotoWithRetry(page, url);
    if (!ok) {
      console.warn("ページ遷移に失敗。次ページへ。");
      await politeSleep();
      continue;
    }

    // 境界 Shapefile の DL リンク(downloadType=5)が描画されるのを待つ。
    // 出ないページ（末尾など）は短めのタイムアウトで諦め、break 判定へ。
    try {
      await page.waitForSelector('a[href*="downloadType=5"]', {
        timeout: 15_000,
      });
    } catch {
      /* リンク無しとみなす */
    }

    const hrefs = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll('a[href*="downloadType=5"]')
      ).map((a) => a.href)
    );

    console.log(`download links: ${hrefs.length}`);
    if (hrefs.length === 0) {
      console.log("リンクがないので終了します。");
      break;
    }

    let pageDownloads = 0;
    const existingFiles = fs.readdirSync(OUT_DIR); // ページごとに1回

    for (let i = 0; i < hrefs.length; i++) {
      const href = hrefs[i];

      try {
        const codeMatch = href.match(/[?&]code=([^&]+)/);
        const code = codeMatch ? decodeURIComponent(codeMatch[1]) : null;

        // 事前スキップ:
        //   保存名は "<code>__<元のファイル名>" で統一しているため、
        //   "<code>__" の前方一致で既存判定する。小地域の code は
        //   01〜47 等と短いので、includes ではなく区切り付き前方一致で誤爆を防ぐ。
        if (code) {
          const hit = existingFiles.find((f) => f.startsWith(`${code}__`));
          if (hit) {
            console.log(`skip existing (pre-check): ${hit}`);
            continue;
          }
        }

        // Referer をリスト画面に設定（セッション/参照元チェック対策）
        const resp = await context.request.get(href, {
          timeout: 60_000,
          headers: { referer: url },
        });
        if (!resp.ok()) {
          console.warn(`HTTP ${resp.status()} for ${href}`);
          await politeSleep();
          continue;
        }

        const body = await resp.body();
        if (!looksLikeZip(body)) {
          // HTML エラーページ等が返ってきたケース
          console.warn(
            `  ZIP ではない応答 (size=${body.length})。` +
              `セッション/Referer が必要な可能性があります。スキップ。`
          );
          await politeSleep();
          continue;
        }

        const origName = safeName(
          filenameFromDisposition(
            resp.headers()["content-disposition"],
            `${code ?? `p${pageNo}_${i}`}.zip`
          )
        );
        // code を接頭辞に付けて保存（スキップ判定と一貫させ、上書き衝突も防ぐ）
        const filename = code ? `${code}__${origName}` : origName;
        const savePath = path.join(OUT_DIR, filename);

        if (fs.existsSync(savePath)) {
          console.log(`skip existing: ${savePath}`);
        } else {
          fs.writeFileSync(savePath, body);
          existingFiles.push(filename);
          console.log(`saved: ${savePath} (${body.length} bytes)`);
          totalDownloads++;
          pageDownloads++;
        }

        await politeSleep();
      } catch (err) {
        console.warn(`error link ${i + 1}/${hrefs.length}: ${err.message}`);
      }
    }

    console.log(`page downloads: ${pageDownloads}`);
    await politeSleep();
  }

  await browser.close();
  console.log(`\nDONE. total downloads: ${totalDownloads}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});