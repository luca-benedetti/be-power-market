# Belgian power market

Live view of Belgian imbalance prices (Elia, quarter-hour and 1-minute) against
ENTSO-E day-ahead prices.

- `docs/` is the GitHub Pages site. `docs/index.html` fetches Elia directly in the
  browser and reads `docs/data/da.json`.
- `scripts/build_data.py` fetches ENTSO-E day-ahead prices and writes `docs/data/da.json`.
  A scheduled workflow (`.github/workflows/update-day-ahead.yml`) runs it every 3 hours.
- `be_imbalance.js` is the Scriptable home-screen widget for iPhone.
- `entsoe_fetch.py` and `test_entsoe.py` are command-line checks for the ENTSO-E API.

## Setup

The ENTSO-E token is never stored in this repo. Add it as a repository secret:

1. Settings → Secrets and variables → Actions → New repository secret
2. Name: `ENTSOE_TOKEN`

To run the fetch locally: `ENTSOE_TOKEN=... python3 scripts/build_data.py`
