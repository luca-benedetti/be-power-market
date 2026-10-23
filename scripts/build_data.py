#!/usr/bin/env python3
"""Fetch ENTSO-E day-ahead prices (A44, Belgium) and write docs/data/da.json.

Reads the security token from the ENTSOE_TOKEN environment variable (a GitHub
Actions secret in CI, or from your shell locally). The token is never printed:
request URLs are not logged, because they contain it.

Writes a 3-day window (yesterday to the day after tomorrow, UTC) so the page
can pick out the local day in Brussels. If the fetch fails, the existing file
is left untouched and the script exits non-zero.
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
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data", "da.json")


def local(tag):
    return tag.rsplit("}", 1)[-1]


def child(el, *names):
    # ENTSO-E documents use a default XML namespace, so match by local name
    for name in names:
        el = next((c for c in el if local(c.tag) == name), None)
        if el is None:
            return None
    return el


def fetch_xml(token, start, end):
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
            with urllib.request.urlopen(f"{base}?{query}", timeout=30) as resp:
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


def parse_points(xml_text):
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
    points.sort()
    return points


def main():
    token = os.environ.get("ENTSOE_TOKEN", "").strip()
    if not token:
        sys.exit("ENTSOE_TOKEN is not set")

    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=3)

    try:
        points = parse_points(fetch_xml(token, start, end))
    except (RuntimeError, ET.ParseError) as e:
        sys.exit(f"day-ahead fetch failed, keeping previous data: {e}")
    if not points:
        sys.exit("day-ahead fetch returned no points, keeping previous data")

    payload = {
        "updated": now.isoformat(timespec="seconds"),
        "zone": BE_EIC,
        "points": [[t.isoformat(timespec="minutes").replace("+00:00", "Z"), v] for t, v in points],
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"wrote {len(points)} day-ahead points to {os.path.normpath(OUT_PATH)}")


if __name__ == "__main__":
    main()
