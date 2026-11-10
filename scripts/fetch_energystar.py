#!/usr/bin/env python3
"""Download rebate-relevant ENERGY STAR certified-product CSVs.

Only datasets mapped in catalog_config.ALLOWED_CATEGORIES are kept, so local
disk stays small without paying for hosted storage.
"""

from __future__ import annotations

import json
import datetime as dt
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from catalog_config import is_allowed_dataset  # noqa: E402

OUT_DIR = PROJECT_ROOT / 'data' / 'raw' / 'energystar'
CATALOG_PATH = PROJECT_ROOT / 'data' / 'es_catalog.json'
MANIFEST_PATH = OUT_DIR / 'manifest.json'

CATALOG_URL = (
    'https://api.us.socrata.com/api/catalog/v1'
    '?domains=data.energystar.gov&only=datasets&limit=100'
)
SKIP_NAME_SUBSTRINGS = (
    'model index',
    'upc codes',
)


def slugify(name: str) -> str:
    text = name.lower()
    text = re.sub(r'^energy star certified\s+', '', text)
    text = re.sub(r'[^a-z0-9]+', '_', text).strip('_')
    return text or 'dataset'


def fetch_json(url: str, ctx: ssl.SSLContext) -> dict:
    req = urllib.request.Request(url, headers={'User-Agent': 'energyRebate/1.0'})
    with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
        return json.load(resp)


def download_csv(dataset_id: str, dest: Path, ctx: ssl.SSLContext) -> int:
    url = f'https://data.energystar.gov/api/views/{dataset_id}/rows.csv?accessType=DOWNLOAD'
    req = urllib.request.Request(url, headers={'User-Agent': 'energyRebate/1.0'})
    with urllib.request.urlopen(req, context=ctx, timeout=300) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return len(data)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ctx = ssl.create_default_context()

    print('Fetching ENERGY STAR catalog…')
    try:
        catalog = fetch_json(CATALOG_URL, ctx)
        CATALOG_PATH.write_text(json.dumps(catalog, indent=2))
    except Exception as err:
        if CATALOG_PATH.exists():
            print(f'  catalog fetch failed ({err}); using cached {CATALOG_PATH.name}')
            catalog = json.loads(CATALOG_PATH.read_text())
        else:
            raise

    datasets = []
    skipped = 0
    for entry in catalog.get('results', []):
        resource = entry.get('resource', {})
        name = resource.get('name') or ''
        dataset_id = resource.get('id')
        if not name or not dataset_id:
            continue
        low = name.lower()
        if any(skip in low for skip in SKIP_NAME_SUBSTRINGS):
            print(f'  skip meta dataset: {name}')
            skipped += 1
            continue
        if not is_allowed_dataset(name):
            print(f'  skip non-rebate dataset: {name}')
            skipped += 1
            continue
        datasets.append({
            'id': dataset_id,
            'name': name,
            'slug': slugify(name),
            'permalink': entry.get('permalink') or entry.get('link'),
        })

    used_slugs: dict[str, int] = {}
    for item in datasets:
        base = item['slug']
        count = used_slugs.get(base, 0)
        used_slugs[base] = count + 1
        item['file'] = f'{base}.csv' if count == 0 else f'{base}_{count + 1}.csv'

    keep_files = {item['file'] for item in datasets}
    for stale in OUT_DIR.glob('*.csv'):
        if stale.name not in keep_files:
            stale.unlink()
            print(f'  removed unused CSV: {stale.name}')

    print(f'Downloading {len(datasets)} rebate-relevant datasets (skipped {skipped})…')
    manifest = []
    for i, item in enumerate(datasets, start=1):
        dest = OUT_DIR / item['file']
        print(f'[{i}/{len(datasets)}] {item["name"]} → {dest.name}')
        try:
            size = download_csv(item['id'], dest, ctx)
            item['bytes'] = size
            item['path'] = str(dest.relative_to(PROJECT_ROOT))
            item['fetched_at'] = (
                dt.datetime.now(dt.timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace('+00:00', 'Z')
            )
            manifest.append(item)
            print(f'  ok ({size:,} bytes)')
        except urllib.error.HTTPError as err:
            print(f'  HTTP {err.code}: {err.reason}')
        except Exception as err:  # noqa: BLE001 - continue other downloads
            print(f'  failed: {err}')
        time.sleep(0.2)

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
    print(f'\nWrote {len(manifest)} files to {OUT_DIR}')
    print(f'Manifest: {MANIFEST_PATH}')


if __name__ == '__main__':
    main()
