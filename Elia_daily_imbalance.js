// Elia Imbalance Price + ENTSO-E Day-Ahead — Day Widget (Scriptable app)
// - As a home screen widget: draws today's quarter-hour price trend (bold,
//   solid step chart) with the minute-by-minute price overlaid (thin, solid
//   step chart) — both from 00:00 to "now" — plus the ENTSO-E day-ahead
//   price as a dotted red step line spanning the FULL day (00:00 -> 24:00),
//   as a static native image with axes.
// - When tapped/opened in-app: shows a larger version of the same native
//   chart (QuickLook, no external dependencies) plus buttons to open the
//   Elia / ENTSO-E data source pages in Safari, and to (re)set your
//   ENTSO-E security token.
//
// Data sources:
//   Elia Open Data Portal (opendata.elia.be)
//     ods162 = Imbalance price per quarter-hour (near real-time, today)
//     ods161 = Imbalance price per minute (near real-time, today)
//   ENTSO-E Transparency Platform (web-api.tp.entsoe.eu)
//     documentType=A44 (day-ahead prices), Belgium bidding zone (EIC 10YBE----------2)
//
// --- ENTSO-E token: how it's stored ----------------------------------
// Your ENTSO-E security token is NEVER hardcoded in this file. It's stored
// once in the iOS Keychain (via Scriptable's Keychain API), which is
// encrypted, local to your device, and not visible in the script text or
// in iCloud sync of the script itself.
//
// Setup (one-time):
//   1. Open this script directly in the Scriptable app (tap it in the
//      app's script list — don't just tap the home screen widget).
//   2. You'll be prompted for your ENTSO-E token the first time; paste it
//      in and tap "Save". It's written to the Keychain under the key
//      "entsoe_api_token".
//   3. From then on, both the in-app run and the home screen widget will
//      read the token from the Keychain automatically — nothing else to do.
// To change or replace the token later: open the script in-app, and in the
// alert that appears choose "Change ENTSO-E token".

const BASE = "https://opendata.elia.be/api/explore/v2.1/catalog/datasets";
const QH_DATASET = "ods162";
const MIN_DATASET = "ods161";
const QH_SOURCE_URL = "https://opendata.elia.be/explore/dataset/ods162/information/";
const MIN_SOURCE_URL = "https://opendata.elia.be/explore/dataset/ods161/information/";

const ENTSOE_BASE = "https://web-api.tp.entsoe.eu/api";
const ENTSOE_SOURCE_URL = "https://transparency.entsoe.eu/transmission-domain/r2/dayAheadPrices/show";
const BE_EIC = "10YBE----------2"; // Belgium bidding zone
const ENTSOE_TOKEN_KEY = "entsoe_api_token";

// --- helpers -----------------------------------------------------------

function findKey(obj, patterns) {
  const keys = Object.keys(obj || {});
  for (const p of patterns) {
    const k = keys.find(k => p.test(k));
    if (k) return k;
  }
  return null;
}

async function fetchJSON(url) {
  const req = new Request(url);
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

function isoNoMillis(d) { return d.toISOString().split(".")[0] + "Z"; }
function pad(n) { return String(n).padStart(2, "0"); }
function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// Paginate through the Opendatasoft API (100 records per page)
async function fetchRange(dataset, start, end, maxRecords = 1500) {
  const where = encodeURIComponent(`datetime >= '${isoNoMillis(start)}' and datetime < '${isoNoMillis(end)}'`);
  let results = [];
  let offset = 0;
  while (results.length < maxRecords) {
    const url = `${BASE}/${dataset}/records?where=${where}&order_by=datetime%20asc&limit=100&offset=${offset}`;
    const data = await fetchJSON(url);
    const page = data.results || [];
    results = results.concat(page);
    if (page.length < 100) break;
    offset += 100;
  }
  return results;
}

function toPoints(records) {
  if (records.length === 0) return [];
  const priceKey = findKey(records[0], [/imbalanceprice/i, /price/i]);
  const timeKey = findKey(records[0], [/datetime/i, /time/i]);
  return records
    .map(r => ({ t: new Date(r[timeKey]), v: Number(r[priceKey]) }))
    .filter(p => !isNaN(p.v));
}

// --- ENTSO-E: token storage (Keychain) ----------------------------------

async function promptForEntsoeToken(existing) {
  const alert = new Alert();
  alert.title = existing ? "Update ENTSO-E Token" : "ENTSO-E API Token";
  alert.message = "Enter your ENTSO-E Transparency Platform security token.\n\nIt is stored securely in the iOS Keychain — not saved in this script.";
  alert.addTextField("Security token", existing || "");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  const choice = await alert.presentAlert();
  if (choice === -1) return existing || null;
  const token = alert.textFieldValue(0).trim();
  if (token.length > 0) {
    Keychain.set(ENTSOE_TOKEN_KEY, token);
    return token;
  }
  return existing || null;
}

// Reads the token from the Keychain. Only prompts (via Alert) when run
// in-app, since widgets can't present UI. Returns null if unavailable.
async function getEntsoeToken({ allowPrompt } = { allowPrompt: false }) {
  if (Keychain.contains(ENTSOE_TOKEN_KEY)) {
    return Keychain.get(ENTSOE_TOKEN_KEY);
  }
  if (!allowPrompt || config.runsInWidget) return null;
  return await promptForEntsoeToken(null);
}

// --- ENTSO-E: fetch + parse day-ahead prices ----------------------------

function fmtEntsoeDate(d) {
  // yyyyMMddHHmm, interpreted by ENTSO-E as UTC
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

async function fetchEntsoeXML(token, start, end) {
  const url = `${ENTSOE_BASE}?securityToken=${token}&documentType=A44&in_Domain=${BE_EIC}&out_Domain=${BE_EIC}` +
    `&periodStart=${fmtEntsoeDate(start)}&periodEnd=${fmtEntsoeDate(end)}`;
  const req = new Request(url);
  req.timeoutInterval = 20;
  const xml = await req.loadString();
  if (xml.includes("Acknowledgement_MarketDocument")) {
    const m = /<text>([\s\S]*?)<\/text>/.exec(xml);
    throw new Error("ENTSO-E: " + (m ? m[1].trim() : "request rejected (check token / domain / dates)"));
  }
  return xml;
}

function resolutionToMinutes(iso) {
  const m = /PT(\d+)M/.exec(iso || "");
  return m ? parseInt(m[1], 10) : 60;
}

// Event-driven parse of the GL_MarketDocument -> TimeSeries -> Period -> Point
// structure. Handles multiple Period/TimeSeries blocks (ENTSO-E sometimes
// splits a multi-day request into several).
function parseEntsoePoints(xml) {
  const points = [];
  const stack = [];
  let curText = "";
  let periodStart = null;
  let resolutionMinutes = null;
  let pointPos = null;
  let pointPrice = null;

  const parser = new XMLParser(xml);
  parser.didStartElement = (name) => {
    stack.push(name);
    curText = "";
    if (name === "Point") { pointPos = null; pointPrice = null; }
  };
  parser.foundCharacters = (text) => { curText += text; };
  parser.didEndElement = (name) => {
    const text = curText.trim();
    const parent = stack[stack.length - 2];
    const grandparent = stack[stack.length - 3];

    if (name === "start" && parent === "timeInterval" && grandparent === "Period") {
      periodStart = new Date(text);
    } else if (name === "resolution" && parent === "Period") {
      resolutionMinutes = resolutionToMinutes(text);
    } else if (name === "position" && parent === "Point") {
      pointPos = parseInt(text, 10);
    } else if (name === "price.amount" && parent === "Point") {
      pointPrice = parseFloat(text);
    } else if (name === "Point") {
      if (periodStart && pointPos !== null && pointPrice !== null && resolutionMinutes !== null) {
        const t = new Date(periodStart.getTime() + (pointPos - 1) * resolutionMinutes * 60000);
        points.push({ t, v: pointPrice });
      }
    } else if (name === "Period") {
      periodStart = null;
      resolutionMinutes = null;
    }
    stack.pop();
    curText = "";
  };
  parser.parse();
  points.sort((a, b) => a.t - b.t);
  return points;
}

async function fetchTodayDayAhead(dayStart, dayEnd, { allowPrompt } = { allowPrompt: false }) {
  try {
    const token = await getEntsoeToken({ allowPrompt });
    if (!token) return [];
    const xml = await fetchEntsoeXML(token, dayStart, dayEnd);
    return parseEntsoePoints(xml);
  } catch (e) {
    console.log("ENTSO-E day-ahead fetch failed: " + e);
    return [];
  }
}

// --- data loading --------------------------------------------------------

async function getTodayData({ allowPrompt } = { allowPrompt: false }) {
  const now = new Date();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const qhRecords = await fetchRange(QH_DATASET, dayStart, now);
  const minRecords = await fetchRange(MIN_DATASET, dayStart, now);
  const da = await fetchTodayDayAhead(dayStart, dayEnd, { allowPrompt });

  return { qh: toPoints(qhRecords), min: toPoints(minRecords), da, now, dayStart, dayEnd };
}

// --- static chart image (step chart, with axes + gridlines) -------------

function drawDashedSegment(ctx, x1, y1, x2, y2, color, lineWidth, dashLen = 4, gapLen = 3) {
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return;
  const ux = dx / dist, uy = dy / dist;
  let drawn = 0, draw = true;
  while (drawn < dist) {
    const segLen = Math.min(draw ? dashLen : gapLen, dist - drawn);
    if (draw) {
      const sx = x1 + ux * drawn, sy = y1 + uy * drawn;
      const ex = x1 + ux * (drawn + segLen), ey = y1 + uy * (drawn + segLen);
      const path = new Path();
      path.move(new Point(sx, sy));
      path.addLine(new Point(ex, ey));
      ctx.setStrokeColor(color);
      ctx.setLineWidth(lineWidth);
      ctx.addPath(path);
      ctx.strokePath();
    }
    drawn += segLen;
    draw = !draw;
  }
}

function makeChart(qhPoints, minPoints, daPoints, dayStart, dayEnd, now, w, h) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const all = qhPoints.concat(minPoints).concat(daPoints);
  if (all.length < 2) return ctx.getImage();

  const marginLeft = 52, marginBottom = 16, marginTop = 6, marginRight = 8;
  const plotW = w - marginLeft - marginRight;
  const plotH = h - marginTop - marginBottom;

  // x-axis domain is the FULL day, fixed, regardless of how much data exists yet
  const tMin = dayStart.getTime(), tMax = dayEnd.getTime();

  const vals = all.map(p => p.v);
  let vMin = Math.min(...vals), vMax = Math.max(...vals);
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const vRange = vMax - vMin;

  function X(t) { return marginLeft + ((t - tMin) / (tMax - tMin)) * plotW; }
  function Y(v) { return marginTop + plotH - ((v - vMin) / vRange) * plotH; }

  // y-axis gridlines + labels
  const numLines = 4;
  ctx.setFont(Font.systemFont(9));
  for (let i = 0; i <= numLines; i++) {
    const v = vMin + (vRange * i) / numLines;
    const y = Y(v);
    const gridPath = new Path();
    gridPath.move(new Point(marginLeft, y));
    gridPath.addLine(new Point(marginLeft + plotW, y));
    ctx.setStrokeColor(new Color("#222"));
    ctx.setLineWidth(1);
    ctx.addPath(gridPath);
    ctx.strokePath();
    ctx.setTextColor(new Color("#999"));
    ctx.drawText(`€${v.toFixed(0)}`, new Point(2, y - 5));
  }

  // zero line, emphasized, if in range
  if (vMin < 0 && vMax > 0) {
    const zeroY = Y(0);
    const zeroPath = new Path();
    zeroPath.move(new Point(marginLeft, zeroY));
    zeroPath.addLine(new Point(marginLeft + plotW, zeroY));
    ctx.setStrokeColor(new Color("#555"));
    ctx.setLineWidth(1);
    ctx.addPath(zeroPath);
    ctx.strokePath();
  }

  // axis border
  const axisPath = new Path();
  axisPath.move(new Point(marginLeft, marginTop));
  axisPath.addLine(new Point(marginLeft, marginTop + plotH));
  axisPath.addLine(new Point(marginLeft + plotW, marginTop + plotH));
  ctx.setStrokeColor(new Color("#555"));
  ctx.setLineWidth(1);
  ctx.addPath(axisPath);
  ctx.strokePath();

  // x-axis labels: fixed to the calendar day, 00:00 / 12:00 / 24:00
  ctx.setTextColor(new Color("#999"));
  ctx.drawText("00:00", new Point(marginLeft, h - 12));
  ctx.drawText("12:00", new Point(marginLeft + plotW / 2 - 12, h - 12));
  ctx.drawText("24:00", new Point(marginLeft + plotW - 28, h - 12));

  // "now" marker
  if (now.getTime() >= tMin && now.getTime() <= tMax) {
    const nowX = X(now.getTime());
    const nowPath = new Path();
    nowPath.move(new Point(nowX, marginTop));
    nowPath.addLine(new Point(nowX, marginTop + plotH));
    ctx.setStrokeColor(new Color("#495057"));
    ctx.setLineWidth(1);
    ctx.addPath(nowPath);
    ctx.strokePath();
  }

  // Solid step-line drawer: value at point i holds until point i+1 ("after"
  // style). extendToEdge stretches the last held value to the right margin
  // (used for series that cover the whole domain); otherwise it stops at
  // the last actual data point (used for qh/min, which only run up to "now").
  function drawStepSeries(points, color, lineWidth, extendToEdge) {
    if (points.length < 2) return;
    const path = new Path();
    let p0 = points[0];
    path.move(new Point(X(p0.t.getTime()), Y(p0.v)));
    for (let i = 1; i < points.length; i++) {
      const pPrev = points[i - 1];
      const pCur = points[i];
      const xCur = X(pCur.t.getTime());
      const yPrev = Y(pPrev.v);
      const yCur = Y(pCur.v);
      path.addLine(new Point(xCur, yPrev));
      path.addLine(new Point(xCur, yCur));
    }
    if (extendToEdge) {
      const last = points[points.length - 1];
      path.addLine(new Point(marginLeft + plotW, Y(last.v)));
    }
    ctx.setStrokeColor(color);
    ctx.setLineWidth(lineWidth);
    ctx.addPath(path);
    ctx.strokePath();
  }

  // Dashed step-line drawer for the day-ahead series: holds each point's
  // value until the next one (or to the right edge for the last point),
  // rendered as dashes instead of a solid line.
  function drawDashedStepSeries(points, color, lineWidth) {
    if (points.length < 1) return;
    for (let i = 0; i < points.length; i++) {
      const cur = points[i];
      const xStart = X(cur.t.getTime());
      const y = Y(cur.v);
      const xEnd = (i + 1 < points.length) ? X(points[i + 1].t.getTime()) : (marginLeft + plotW);
      drawDashedSegment(ctx, xStart, y, xEnd, y, color, lineWidth);
      if (i + 1 < points.length) {
        const yNext = Y(points[i + 1].v);
        drawDashedSegment(ctx, xEnd, y, xEnd, yNext, color, lineWidth);
      }
    }
  }

  drawDashedStepSeries(daPoints, new Color("#ff6b6b"), 1.5);      // dotted red = day-ahead (full day)
  drawStepSeries(minPoints, new Color("#868e96"), 1, false);      // thin gray = minute (up to now)
  drawStepSeries(qhPoints, new Color("#4dabf7"), 2.5, false);     // bold blue = quarter-hour (up to now)

  return ctx.getImage();
}

// --- widget (home screen) -----------------------------------------------

async function buildWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#0b0f14");
  widget.setPadding(12, 14, 12, 14);

  try {
    const { qh, min, da, now, dayStart, dayEnd } = await getTodayData({ allowPrompt: false });
    const lastQh = qh[qh.length - 1];
    const lastMin = min[min.length - 1];
    const daNow = da.filter(p => p.t.getTime() <= now.getTime()).slice(-1)[0];

    const title = widget.addText("ELIA IMBALANCE — TODAY");
    title.font = Font.mediumSystemFont(10);
    title.textColor = Color.gray();
    widget.addSpacer(4);

    if (config.widgetFamily === "small") {
      const priceText = widget.addText(lastQh ? `€${lastQh.v.toFixed(2)}` : "--");
      priceText.font = Font.boldSystemFont(28);
      priceText.textColor = lastQh && lastQh.v >= 0 ? new Color("#ff6b6b") : new Color("#51cf66");
      const sub = widget.addText("EUR/MWh · quarter-hour");
      sub.font = Font.systemFont(10);
      sub.textColor = Color.gray();
      if (lastMin) {
        widget.addSpacer(4);
        const minRow = widget.addText(`1 min: €${lastMin.v.toFixed(2)}`);
        minRow.font = Font.systemFont(11);
        minRow.textColor = Color.white();
      }
    } else {
      const w = config.widgetFamily === "large" ? 300 : 280;
      const h = config.widgetFamily === "large" ? 170 : 100;
      const img = makeChart(qh, min, da, dayStart, dayEnd, now, w * 2, h * 2); // 2x for retina sharpness
      const imgWidget = widget.addImage(img);
      imgWidget.imageSize = new Size(w, h);
      widget.addSpacer(6);

      const legend = widget.addText("— blue: QH   — gray: minute   ┄ red: day-ahead (est.)");
      legend.font = Font.systemFont(9);
      legend.textColor = Color.gray();

      if (lastQh) {
        widget.addSpacer(4);
        const priceRow = widget.addText(`Quarter-hour: €${lastQh.v.toFixed(2)}/MWh`);
        priceRow.font = Font.boldSystemFont(13);
        priceRow.textColor = lastQh.v >= 0 ? new Color("#ff6b6b") : new Color("#51cf66");
      }
      if (lastMin) {
        widget.addSpacer(2);
        const minRow = widget.addText(`1 min: €${lastMin.v.toFixed(2)}/MWh (${fmtTime(lastMin.t)})`);
        minRow.font = Font.systemFont(11);
        minRow.textColor = Color.white();
      }
      if (daNow) {
        widget.addSpacer(2);
        const daRow = widget.addText(`Day-ahead (this hour): €${daNow.v.toFixed(2)}/MWh`);
        daRow.font = Font.systemFont(11);
        daRow.textColor = new Color("#ff6b6b");
      }
    }

    const updated = widget.addText(`Updated ${fmtTime(now)} · tap for larger chart & source`);
    updated.font = Font.systemFont(8);
    updated.textColor = Color.gray();

  } catch (e) {
    const err = widget.addText("Elia data unavailable");
    err.font = Font.mediumSystemFont(13);
    err.textColor = Color.white();
  }

  widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  return widget;
}

// --- tapped / opened in-app: bigger native chart + source links ---------

async function showOnOpen() {
  const { qh, min, da, now, dayStart, dayEnd } = await getTodayData({ allowPrompt: true });

  const bigImg = makeChart(qh, min, da, dayStart, dayEnd, now, 1000, 600);
  await QuickLook.present(bigImg);

  const lastQh = qh[qh.length - 1];
  const lastMin = min[min.length - 1];
  const daNow = da.filter(p => p.t.getTime() <= now.getTime()).slice(-1)[0];

  const a = new Alert();
  a.title = "Elia / ENTSO-E — data sources";
  a.message =
    (lastQh ? `Quarter-hour: €${lastQh.v.toFixed(2)}/MWh (${fmtTime(lastQh.t)})\n` : "") +
    (lastMin ? `1 min: €${lastMin.v.toFixed(2)}/MWh (${fmtTime(lastMin.t)})\n` : "") +
    (daNow ? `Day-ahead (this hour): €${daNow.v.toFixed(2)}/MWh\n` : "") +
    `Updated ${fmtTime(now)}`;
  a.addAction("Open quarter-hour source");
  a.addAction("Open minute source");
  a.addAction("Open ENTSO-E source");
  a.addAction(Keychain.contains(ENTSOE_TOKEN_KEY) ? "Change ENTSO-E token" : "Set ENTSO-E token");
  a.addCancelAction("Close");

  const choice = await a.presentAlert();
  if (choice === 0) Safari.open(QH_SOURCE_URL);
  else if (choice === 1) Safari.open(MIN_SOURCE_URL);
  else if (choice === 2) Safari.open(ENTSOE_SOURCE_URL);
  else if (choice === 3) {
    const existing = Keychain.contains(ENTSOE_TOKEN_KEY) ? Keychain.get(ENTSOE_TOKEN_KEY) : null;
    await promptForEntsoeToken(existing);
  }
}

// --- entry point ----------------------------------------------------------

if (config.runsInWidget) {
  const widget = await buildWidget();
  Script.setWidget(widget);
} else {
  await showOnOpen();
}

Script.complete();