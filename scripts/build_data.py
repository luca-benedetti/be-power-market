#!/usr/bin/env python3
"""Update docs/data/da.json with ENTSO-E day-ahead prices (A44, Belgium).

Covers the last HISTORY_DAYS days plus two days ahead. Stored values are kept,
so history beyond the fetched window is never lost. Imbalance prices are not
stored here: the page reads Elia's history directly.

ENTSOE_TOKEN is read from the environment and is never printed: request URLs
are not logged, because they contain it.

Series are stored as parallel arrays: minutes since the Unix epoch (UTC) and
prices in EUR/MWh. On failure the previous file is kept and the script exits 1.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

ENDPOINTS = ["https://web-api.tp.entsoe.eu/api", "https://external-api.tp.entsoe.eu/api"]
BE_EIC = "10YBE----------2"
HISTORY_DAYS = 360  # ENTSO-E allows at most one year per request
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")
DA_PATH = os.path.join(DATA_DIR, "da.json")


def local(tag):
    return tag.rsplit("}", 1)[-1]


def child(el, *names):
    # ENTSO-E documents use a default XML namespace, so match by local name
    for name in names:
        el = next((c for c in el if local(c.tag) == name), None)
        if el is None:
            return None
    return el


def minute_of(dt):
    return int(dt.timestamp() // 60)


def load_series(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return dict(zip(data["t"], data["v"]))


def save_series(path, series):
    ts = sorted(series)
    payload = {"t": ts, "v": [round(series[t], 2) for t in ts]}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))


def fetch_entsoe_xml(token, start, end):
    params = {
        "securityToken": token,
        "documentType": "A44",
        "contract_MarketAgreement.type": "A01",
        "in_Domain": BE_EIC,
        "out_Domain": BE_EIC,
        "periodStart": start.strftime("%Y%m%d%H%M"),
        "periodEnd": end.strftime("%Y%m%d%H%M"),
    }
    query = urllib.parse.urlencode(params)
    last_error = None
    for base in ENDPOINTS:
        try:
            with urllib.request.urlopen(f"{base}?{query}", timeout=60) as resp:
                body = resp.read().decode("utf-8", "replace")
                ctype = resp.headers.get("Content-Type", "")
        except (urllib.error.URLError, TimeoutError) as e:
            last_error = f"network error on {base}: {type(e).__name__}"
            continue
        if "html" in ctype.lower() or not re.match(r"\s*<", body):
            last_error = f"non-XML response from {base}"
            continue
        if "Acknowledgement_MarketDocument" in body:
            root = ET.fromstring(body)
            texts = [el.text.strip() for el in root.iter() if local(el.tag) == "text" and el.text]
            raise RuntimeError("ENTSO-E rejected the request: " + (texts[0] if texts else "unknown reason"))
        return body
    raise RuntimeError(last_error or "all endpoints failed")


def parse_entsoe_points(xml_text):
    root = ET.fromstring(xml_text)
    points = []
    for ts in root.iter():
        if local(ts.tag) != "TimeSeries":
            continue
        for period in ts:
            if local(period.tag) != "Period":
                continue
            start_el = child(period, "timeInterval", "start")
            res_el = child(period, "resolution")
            if start_el is None or res_el is None or not start_el.text or not res_el.text:
                continue
            start = datetime.fromisoformat(start_el.text.replace("Z", "+00:00"))
            m = re.fullmatch(r"PT(\d+)M", res_el.text.strip())
            minutes = int(m.group(1)) if m else 60
            for point in period:
                if local(point.tag) != "Point":
                    continue
                pos = child(point, "position")
                amount = child(point, "price.amount")
                if pos is None or amount is None or not pos.text or not amount.text:
                    continue
                t = start + timedelta(minutes=minutes * (int(pos.text) - 1))
                points.append((t, float(amount.text)))
    return points


def update_day_ahead(token, now):
    start = (now - timedelta(days=HISTORY_DAYS)).replace(hour=0, minute=0, second=0, microsecond=0)
    end = (now + timedelta(days=2)).replace(hour=0, minute=0, second=0, microsecond=0)
    points = parse_entsoe_points(fetch_entsoe_xml(token, start, end))
    if not points:
        raise RuntimeError("no points returned")
    series = load_series(DA_PATH)
    series.update({minute_of(t): v for t, v in points})
    save_series(DA_PATH, series)
    print(f"day-ahead: {len(points)} points fetched, {len(series)} stored")


def main():
    token = os.environ.get("ENTSOE_TOKEN", "").strip()
    if not token:
        sys.exit("ENTSOE_TOKEN is not set")

    now = datetime.now(timezone.utc)
    try:
        update_day_ahead(token, now)
    except (RuntimeError, ET.ParseError, OSError, ValueError, KeyError) as e:
        sys.exit(f"day-ahead failed, keeping previous data: {e}")


if __name__ == "__main__":
    main()
