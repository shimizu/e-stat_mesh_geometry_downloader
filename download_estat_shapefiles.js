// download_estat_shapefiles.js
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE_URL = "https://www.e-stat.go.jp/gis/statmap-search";

// メッシュ単位（aggregateUnitForBoundary）。CLI引数で指定可能。
//   H = 4次メッシュ（500mメッシュ） / S = 1kmメッシュ ...等
const UNIT = process.argv[2] || "H";
const OUT_DIR = path.resolve(__dirname, `estat_shapefiles_${UNIT}`);

const SLEEP_MIN = 2500;
const SLEEP_MAX = 6000;
const MAX_PAGES = 999;

const BASE_PARAMS = {
  type: "2",
  aggregateUnitForBoundary: UNIT,
  coordsys: "1",      // 世界測地系緯度経度
  format: "shape",    // Shapefile
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function politeSleep() {
  const ms = SLEEP_MIN + Math.random() * (SLEEP_MAX - SLEEP_MIN);
  return sleep(ms);
}

function makeUrl(pageNo) {
  const params = new URLSearchParams({
    page: String(pageNo),
    ...BASE_PARAMS,
  });
  return `${BASE_URL}?${params.toString()}`;
}

function safeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

// content-disposition からファイル名を取り出す。
//   filename*=UTF-8''<RFC5987 encoded>  を優先、無ければ filename="..."
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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`unit=${UNIT}  OUT_DIR=${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  let totalDownloads = 0;

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const url = makeUrl(pageNo);
    console.log(`\n=== page ${pageNo}: ${url}`);

    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });

    // 実際のDLリンクは <a href=".../data?...&downloadType=5">（境界Shapefile）。
    // 定義書(downloadType=1)等は含まれない。
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="downloadType=5"]')).map(
        (a) => a.href
      )
    );

    console.log(`download links: ${hrefs.length}`);

    if (hrefs.length === 0) {
      console.log("リンクがないので終了します。");
      break;
    }

    let pageDownloads = 0;

    for (let i = 0; i < hrefs.length; i++) {
      const href = hrefs[i];

      try {
        // 一旦ファイル名を code から仮決め（フォールバック用）
        const codeMatch = href.match(/[?&]code=([^&]+)/);
        const fallback = `${UNIT}_${codeMatch ? codeMatch[1] : `p${pageNo}_${i}`}.zip`;

        const resp = await context.request.get(href, { timeout: 60_000 });
        if (!resp.ok()) {
          console.warn(`HTTP ${resp.status()} for ${href}`);
          await politeSleep();
          continue;
        }

        const filename = safeName(
          filenameFromDisposition(resp.headers()["content-disposition"], fallback)
        );
        const savePath = path.join(OUT_DIR, filename);

        if (fs.existsSync(savePath)) {
          console.log(`skip existing: ${savePath}`);
        } else {
          const body = await resp.body();
          fs.writeFileSync(savePath, body);
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
