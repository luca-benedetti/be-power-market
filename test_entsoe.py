#!/usr/bin/env python3
"""
Minimal ENTSO-E day-ahead price fetch test.

Usage:
    pip install requests
    python test_entsoe.py YOUR_TOKEN_HERE

Prints the HTTP status code and the raw XML response (or the first
part of it) so we can see exactly what ENTSO-E's server is saying.
"""

import sys
import datetime
import requests

BE_EIC = "10YBE----------2"  # Belgium bidding zone

# ENTSO-E appears to be mid-migration: the old endpoint intermittently
# serves a plain website/HTML page (503) instead of the API's XML.
# Several other integrations report the same symptom and switched to
# the endpoint below. We test both here to confirm.
ENDPOINTS = {
    "old (web-api)": "https://web-api.tp.entsoe.eu/api",
    "new (external-api)": "https://external-api.tp.entsoe.eu/api",
}


def fmt(dt: datetime.datetime) -> str:
    return dt.strftime("%Y%m%d%H%M")


def main():
    if len(sys.argv) < 2:
        print("Usage: python test_entsoe.py YOUR_TOKEN")
        sys.exit(1)

    token = sys.argv[1]

    # today 00:00 UTC -> tomorrow 00:00 UTC
    now = datetime.datetime.utcnow()
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + datetime.timedelta(days=1)

    params = {
        "securityToken": token,
        "documentType": "A44",
        "BusinessType": "A62",
        "in_Domain": BE_EIC,
        "out_Domain": BE_EIC,
        "periodStart": fmt(day_start),
        "periodEnd": fmt(day_end),
    }

    print(f"Requesting day-ahead prices for {day_start} -> {day_end} (UTC)...\n")

    for label, base_url in ENDPOINTS.items():
        print(f"=== Testing {label}: {base_url} ===")
        try:
            resp = requests.get(base_url, params=params, timeout=20)
        except requests.exceptions.RequestException as e:
            print(f"CONNECTION-LEVEL ERROR: {e}\n")
            continue

        print(f"HTTP status code: {resp.status_code}")
        print("---- Response body (first 500 chars) ----")
        print(resp.text[:500])
        print("---- end ----")

        if resp.status_code == 200 and "Acknowledgement_MarketDocument" in resp.text:
            print(">> Got an Acknowledgement (rejection), not data. See <text> above.\n")
        elif resp.status_code == 200 and "<Point>" in resp.text:
            print(">> SUCCESS: got actual price points back.\n")
        elif resp.status_code != 200:
            print(">> Non-200 HTTP status: server-side issue on this endpoint.\n")


if __name__ == "__main__":
    main()