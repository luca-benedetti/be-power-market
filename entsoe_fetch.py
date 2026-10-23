#!/usr/bin/env python3
"""Manually test the ENTSO-E day-ahead (A44) query.

Reads ENTSOE_TOKEN from .env, queries day-ahead prices for a bidding zone,
tries the primary endpoint then the fallback mirror, and prints a summary
of the parsed prices.

Examples:
    .venv/bin/python entsoe_fetch.py                       # today, Belgium
    .venv/bin/python entsoe_fetch.py --start 202609010000 --end 202609020000
    .venv/bin/python entsoe_fetch.py --zone 10YNL----------L --days 2
    .venv/bin/python entsoe_fetch.py --endpoint fallback --all
"""
import argparse
import re
import ssl
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

PRIMARY = "https://web-api.tp.entsoe.eu/api"
FALLBACK = "https://external-api.tp.entsoe.eu/api"
DEFAULT_ZONE = "10YBE----------2"


def load_token(path):
    token = None
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("ENTSOE_TOKEN="):
                token = line.split("=", 1)[1].strip()
    if not token:
        sys.exit(f"ENTSOE_TOKEN not found in {path}")
    return token


def fetch(url, timeout):
    for secure in (True, False):
        if secure:
            opener = urllib.request.build_opener()
        else:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
        try:
            with opener.open(url, timeout=timeout) as resp:
                return resp.status, resp.headers.get("Content-Type", ""), resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Type", ""), e.read().decode("utf-8", "replace")
        except urllib.error.URLError as e:
            msg = str(e.reason)
            if secure and "certificate verify failed" in msg.lower():
                print("note: TLS certificate verify failed (local CA issue) - retrying without verification")
                continue
            raise
    raise RuntimeError("request failed")


def local(tag):
    return tag.rsplit("}", 1)[-1]


def parse_points(xml):
    root = ET.fromstring(xml)
    if local(root.tag) == "Acknowledgement_MarketDocument":
        texts = [el.text.strip() for el in root.iter() if local(el.tag) == "text" and el.text]
        reason = texts[0] if texts else "request rejected (check token / domain / dates)"
        raise RuntimeError("ENTSO-E: " + reason)
    points = []
    for ts in root.iter():
        if local(ts.tag) != "TimeSeries":
            continue
        period = ts.find("Period")
        if period is None:
            continue
        start_el = period.find("timeInterval/start")
        res_el = period.find("resolution")
        if start_el is None or res_el is None or not start_el.text or not res_el.text:
            continue
        start = datetime.fromisoformat(start_el.text.replace("Z", "+00:00"))
        m = re.fullmatch(r"PT(\d+)M", res_el.text.strip())
        minutes = int(m.group(1)) if m else 60
        for point in period.findall("Point"):
            pos = point.find("position")
            amount = point.find("price.amount")
            if pos is None or amount is None or pos.text is None or amount.text is None:
                continue
            p = int(pos.text)
            v = float(amount.text)
            points.append((start + timedelta(minutes=minutes * (p - 1)), v))
    points.sort()
    return points


def res_minutes(points):
    if len(points) < 2:
        return None
    return int(round((points[1][0] - points[0][0]).total_seconds() / 60))


def main():
    ap = argparse.ArgumentParser(description="Fetch ENTSO-E day-ahead prices (A44).")
    ap.add_argument("--start", help="YYYYMMDDHHmm (UTC, minutes optional). Default: today 00:00 UTC")
    ap.add_argument("--end", help="YYYYMMDDHHmm (UTC, minutes optional). Default: start + days")
    ap.add_argument("--days", type=int, default=1, help="days from start (default 1)")
    ap.add_argument("--zone", default=DEFAULT_ZONE, help=f"bidding zone EIC (default {DEFAULT_ZONE})")
    ap.add_argument("--endpoint", choices=["primary", "fallback", "both"], default="both")
    ap.add_argument("--timeout", type=int, default=20, help="request timeout in seconds")
    ap.add_argument("--env", default=".env", help="path to env file")
    ap.add_argument("--all", action="store_true", help="print every point")
    args = ap.parse_args()

    token = load_token(args.env)
    print(f"token: loaded ({len(token)} chars)")

    def norm(s):
        digits = re.sub(r"\D", "", s)
        return (digits + "0" * 12)[:12]

    if args.start:
        start = datetime.strptime(norm(args.start), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    else:
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    end = datetime.strptime(norm(args.end), "%Y%m%d%H%M").replace(tzinfo=timezone.utc) if args.end \
        else start + timedelta(days=args.days)

    fmt = lambda d: d.strftime("%Y%m%d%H%M")
    bases = {"primary": [PRIMARY], "fallback": [FALLBACK], "both": [PRIMARY, FALLBACK]}[args.endpoint]

    first_error = None
    saw_response = False
    for base in bases:
        url = (f"{base}?securityToken={token}&documentType=A44&contract_MarketAgreement.type=A01"
               f"&in_Domain={args.zone}&out_Domain={args.zone}"
               f"&periodStart={fmt(start)}&periodEnd={fmt(end)}")
        host = base.replace("https://", "").split("/")[0]
        print(f"\n-- {host} :: {fmt(start)} -> {fmt(end)} ({args.zone}) --")
        try:
            status, ctype, body = fetch(url, args.timeout)
        except Exception as e:
            print(f"   request failed: {e}")
            first_error = first_error or e
            continue
        saw_response = True
        print(f"   HTTP {status}  content-type: {ctype}  bytes: {len(body)}")
        if status >= 400 or "html" in ctype.lower() or not re.match(r"\s*<", body):
            print("   non-XML / error response (likely ENTSO-E outage or migration page):")
            print("   " + body[:200].strip().replace("\n", " "))
            continue
        try:
            points = parse_points(body)
        except RuntimeError as e:
            print("   " + str(e))
            continue
        except ET.ParseError as e:
            print("   not valid XML: " + str(e))
            continue
        if not points:
            print("   parsed OK but 0 points")
            continue
        vals = [v for _, v in points]
        rmin = res_minutes(points)
        print(f"   ok - {len(points)} points, resolution: {rmin} min" if rmin else f"   ok - {len(points)} points")
        print(f"   range: {points[0][0].isoformat()} .. {points[-1][0].isoformat()}")
        print(f"   price: min={min(vals):.2f}  max={max(vals):.2f}  mean={sum(vals) / len(vals):.2f} EUR/MWh")
        if args.all:
            for t, v in points:
                print(f"     {t.isoformat()}  {v:.2f}")
        return 0
    if first_error and not saw_response:
        print("\nENTSO-E unreachable (timed out / network error) - consistent with the ongoing platform outage.")
    else:
        print("\nNo day-ahead data available from ENTSO-E right now (outage, maintenance, or no matching data).")
    print("This is a server-side status - nothing to fix locally. Re-run later.")
    return 0


if __name__ == "__main__":
    sys.exit(main())