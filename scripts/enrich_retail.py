#!/usr/bin/env python3
"""
Periodically enrich appliances with retail product names and store prices.

Home Depot and Lowe's block direct scrapes (HTTP 403). This script uses Bing
Shopping results, which still surface Home Depot / Lowe's offers with titles
and prices that are good enough for non-realtime rebate browsing.

Outputs:
  data/raw/retail_listings.csv

Optional:
  --apply-db   also upsert into data/rebates.db.retail_listings
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import html as html_lib
import json
import re
import sqlite3
import ssl
import time
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
RAW_DIR = PROJECT_ROOT / 'data' / 'raw'
DB_PATH = PROJECT_ROOT / 'data' / 'rebates.db'
OUT_CSV = RAW_DIR / 'retail_listings.csv'

STORES = {
    'home_depot': re.compile(r'home\s*depot', re.I),
    'lowes': re.compile(r"lowe'?s", re.I),
}

USER_AGENT = (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/122.0.0.0 Safari/537.36'
)


def fetch(url: str) -> str:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml',
        },
    )
    with urllib.request.urlopen(req, context=ctx, timeout=45) as resp:
        return resp.read().decode('utf-8', 'replace')


def parse_price(text: str) -> float | None:
    cleaned = text.replace(',', '').replace('$', '').strip()
    try:
        value = float(cleaned)
    except ValueError:
        return None
    if value < 5 or value > 50000:
        return None
    return value


def pretty_brand(brand: str) -> str:
    raw = (brand or '').replace('_', ' ').strip()
    specials = {
        'ge': 'GE',
        'lg': 'LG',
        'aosmith': 'A. O. Smith',
        'ao smith': 'A. O. Smith',
        'rheem': 'Rheem',
        'bosch': 'Bosch',
        'carrier': 'Carrier',
        'friedrich': 'Friedrich',
    }
    return specials.get(raw.lower(), raw.title())


def pretty_name(value: str) -> str:
    text = re.sub(r'[_-]+', ' ', value or '').strip()
    if not text:
        return ''
    parts = []
    for word in text.split():
        low = word.lower()
        if low in {'ge', 'lg', 'btu', 'uef', 'hp', 'ids'}:
            parts.append(low.upper())
        elif low in {'a.', 'o.'}:
            parts.append(low.upper())
        else:
            parts.append(word[:1].upper() + word[1:])
    return ' '.join(parts)


def tokenize_model(model_number: str) -> list[str]:
    raw = re.sub(r'[^a-zA-Z0-9]+', ' ', model_number or '').upper().split()
    skip = {
        'THE', 'AND', 'FOR', 'WITH', 'PROP', 'TYPE', 'MODEL', 'SERIES',
        'RH', 'HE', 'EC', 'HP', 'WH', 'GAL'
    }
    return [t for t in raw if len(t) >= 4 and t not in skip]


def score_offer(title: str, model_number: str, brand: str, model_name: str = '') -> int:
    score = 0
    title_u = title.upper()
    brand_u = (brand or '').upper()
    if brand_u and brand_u in title_u:
        score += 3
    elif brand_u.replace('.', '') and brand_u.replace('.', '') in title_u.replace('.', ''):
        score += 2

    model_tokens = tokenize_model(model_number)
    if model_tokens:
        hits = sum(1 for t in model_tokens if t in title_u)
        score += hits * 3
        if hits == len(model_tokens):
            score += 6

    name_tokens = [
        t for t in re.sub(r'[^a-zA-Z0-9]+', ' ', model_name or '').upper().split()
        if len(t) >= 4 and t not in {
            'WITH', 'FROM', 'GALLON', 'WATER', 'HEATER', 'HEAT', 'PUMP',
            'DIRECT', 'VENT', 'POWER', 'NATURAL', 'ELECTRIC', 'SMART',
            'TALL', 'SHORT', 'HYBRID', 'HIGH', 'EFFICIENCY'
        }
    ]
    if name_tokens:
        name_hits = sum(1 for t in name_tokens if t in title_u)
        score += name_hits
        if name_hits >= max(1, len(name_tokens) // 2):
            score += 2
    return score


def parse_bing_shop(html: str) -> list[dict]:
    offers = []
    # Each offer card tends to include title, price, then seller nearby.
    pattern = re.compile(
        r'<div class="br-offTtl[^"]*"[^>]*>.*?<span title="([^"]+)".*?'
        r'<div class="br-price">([^<]+)</div>.*?'
        r'(?:<span class="br-offSlrTxt">([^<]+)</span>|<span class="br-liaIc">)',
        re.S | re.I,
    )
    for match in pattern.finditer(html):
        title = html_lib.unescape(match.group(1)).strip()
        price = parse_price(html_lib.unescape(match.group(2)))
        seller_raw = (match.group(3) or '').strip()
        if price is None or not title:
            continue
        store = None
        for key, rx in STORES.items():
            if rx.search(seller_raw) or rx.search(title):
                store = key
                break
        if not store:
            # Local inventory icon cards are often Home Depot without text seller.
            if 'br-liaIc' in match.group(0) and not seller_raw:
                store = 'home_depot'
        if not store:
            continue
        offers.append({
            'store': store,
            'product_name': title,
            'price': price,
            'seller': seller_raw or store,
        })
    return offers


def search_retail(brand: str, model_number: str, category: str, model_name: str = '') -> list[dict]:
    queries = []
    if brand and model_number:
        queries.append(f'{brand} {model_number}')
        queries.append(f'{model_number} Home Depot')
        queries.append(f'{model_number} Lowe\'s')
    if brand and model_name:
        queries.append(f'{brand} {model_name}')
    if not queries:
        queries.append(' '.join(p for p in [brand, model_number, category.replace('_', ' ')] if p))

    offers = []
    seen_queries = set()
    for query in queries:
        key = query.lower().strip()
        if not key or key in seen_queries:
            continue
        seen_queries.add(key)
        url = 'https://www.bing.com/shop?q=' + urllib.parse.quote(query)
        try:
            html = fetch(url)
            offers.extend(parse_bing_shop(html))
        except Exception:
            continue
        time.sleep(0.8)

    # Keep the best-scoring offer per store.
    best: dict[str, dict] = {}
    for offer in offers:
        offer['score'] = score_offer(offer['product_name'], model_number, brand, model_name)
        offer['token_hits'] = sum(
            1 for t in tokenize_model(model_number) if t in offer['product_name'].upper()
        )
        prev = best.get(offer['store'])
        if prev is None or offer['score'] > prev['score'] or (
            offer['score'] == prev['score'] and offer['price'] < prev['price']
        ):
            best[offer['store']] = offer
    return list(best.values())


def seed_model_ids() -> set[str]:
    path = RAW_DIR / 'appliances.csv'
    if not path.exists():
        return set()
    with path.open('r', encoding='utf-8-sig', newline='') as handle:
        return {row['model_id'].strip().lower() for row in csv.DictReader(handle) if row.get('model_id')}


def load_targets(conn: sqlite3.Connection, limit: int, seed_only: bool) -> list[dict]:
    cur = conn.cursor()
    seeds = sorted(seed_model_ids())
    if seed_only:
        if not seeds:
            return []
        placeholders = ','.join('?' for _ in seeds)
        rows = cur.execute(
            f"""
            SELECT a.model_id, a.brand, a.category, a.model_number, a.attrs_json
            FROM appliances a
            WHERE a.model_id IN ({placeholders})
            ORDER BY a.brand, a.model_id
            """,
            seeds,
        ).fetchall()
    else:
        rows = cur.execute(
            """
            SELECT a.model_id, a.brand, a.category, a.model_number, a.attrs_json
            FROM appliances a
            WHERE a.category IN ('water_heater','heat_pump','induction_stove','electric_cooking')
            ORDER BY CASE WHEN a.model_id LIKE 'es-%' THEN 1 ELSE 0 END, a.brand, a.model_id
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    targets = []
    for r in rows:
        model_name = ''
        try:
            attrs = json.loads(r[4] or '{}')
            raw_name = attrs.get('model_name')
            if isinstance(raw_name, list):
                model_name = str(raw_name[0]) if raw_name else ''
            elif raw_name:
                model_name = str(raw_name)
        except Exception:
            model_name = ''
        targets.append({
            'model_id': r[0],
            'brand': r[1] or '',
            'category': r[2] or '',
            'model_number': r[3] or '',
            'model_name': model_name,
        })
    return targets[:limit]


def read_existing_csv() -> dict[tuple[str, str], dict]:
    existing = {}
    if not OUT_CSV.exists():
        return existing
    with OUT_CSV.open('r', encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            existing[(row['model_id'], row['store'])] = row
    return existing


def write_csv(rows: list[dict]) -> None:
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        'model_id', 'store', 'product_name', 'price', 'currency',
        'url', 'model_number', 'fetched_at', 'match_score'
    ]
    with OUT_CSV.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def ensure_retail_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        '''
        CREATE TABLE IF NOT EXISTS retail_listings (
            model_id TEXT,
            store TEXT,
            product_name TEXT,
            price REAL,
            currency TEXT,
            url TEXT,
            model_number TEXT,
            fetched_at TEXT,
            match_score INTEGER,
            PRIMARY KEY (model_id, store)
        )
        '''
    )
    conn.execute('CREATE INDEX IF NOT EXISTS idx_retail_model ON retail_listings(model_id)')


def apply_to_db(rows: list[dict]) -> None:
    conn = sqlite3.connect(DB_PATH)
    ensure_retail_table(conn)
    conn.executemany(
        '''
        INSERT INTO retail_listings (
            model_id, store, product_name, price, currency, url, model_number, fetched_at, match_score
        ) VALUES (
            :model_id, :store, :product_name, :price, :currency, :url, :model_number, :fetched_at, :match_score
        )
        ON CONFLICT(model_id, store) DO UPDATE SET
            product_name=excluded.product_name,
            price=excluded.price,
            currency=excluded.currency,
            url=excluded.url,
            model_number=excluded.model_number,
            fetched_at=excluded.fetched_at,
            match_score=excluded.match_score
        ''',
        rows,
    )
    conn.commit()
    conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description='Enrich appliances with retail names/prices')
    parser.add_argument('--limit', type=int, default=40, help='Max appliances to enrich')
    parser.add_argument('--seed-only', action='store_true', help='Only enrich non-ENERGY-STAR seed models')
    parser.add_argument('--apply-db', action='store_true', help='Upsert results into rebates.db')
    parser.add_argument('--sleep', type=float, default=1.5, help='Delay between Bing requests')
    parser.add_argument('--min-score', type=int, default=3, help='Minimum title match score to keep')
    args = parser.parse_args()

    if not DB_PATH.exists():
        raise SystemExit(f'Database not found at {DB_PATH}. Run npm run build:db first.')

    conn = sqlite3.connect(DB_PATH)
    targets = load_targets(conn, args.limit, args.seed_only)
    conn.close()

    existing = read_existing_csv()
    print(f'Enriching {len(targets)} appliances via Bing Shopping…')

    for i, target in enumerate(targets, start=1):
        model_number = target['model_number'] or target['model_id']
        brand = target['brand']
        print(f'[{i}/{len(targets)}] {brand} {model_number}')
        # Replace prior rows for this model so stale/wrong prices don't linger.
        for key in list(existing):
            if key[0] == target['model_id']:
                existing.pop(key, None)
        try:
            offers = search_retail(
                brand,
                model_number,
                target['category'],
                target.get('model_name') or '',
            )
        except Exception as err:  # noqa: BLE001
            print(f'  failed: {err}')
            time.sleep(args.sleep)
            continue

        kept = 0
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
        tokens = tokenize_model(model_number)
        for offer in offers:
            token_hits = offer.get('token_hits', 0)
            title_u = offer['product_name'].upper()
            brand_u = brand.upper()
            has_brand = bool(brand_u) and (
                brand_u in title_u or brand_u.replace('.', '') in title_u.replace('.', '')
            )
            # Prefer exact model-number hits. If absent, require brand in the title
            # plus a solid similarity score so generic "40 gal water heater" cards drop out.
            if token_hits == 0:
                if not has_brand or offer['score'] < max(args.min_score + 1, 5):
                    print(f'  skip unrelated {offer["store"]} score={offer["score"]} brand={has_brand} · {offer["product_name"][:60]}')
                    continue
            if offer['score'] < args.min_score:
                print(f'  skip weak {offer["store"]} score={offer["score"]} · {offer["product_name"][:60]}')
                continue
            row = {
                'model_id': target['model_id'],
                'store': offer['store'],
                'product_name': offer['product_name'],
                'price': f'{offer["price"]:.2f}',
                'currency': 'USD',
                'url': '',
                'model_number': model_number,
                'fetched_at': now,
                'match_score': str(offer['score']),
            }
            existing[(row['model_id'], row['store'])] = row
            kept += 1
            print(f'  {offer["store"]}: ${offer["price"]:.2f} · {offer["product_name"][:70]}')

        # Always keep a friendly catalog title for UI display.
        model_name = pretty_name(target['model_name'] or '')
        brand_nice = pretty_brand(brand)
        if model_name and brand_nice and brand_nice.lower() in model_name.lower():
            fallback_name = model_name
        elif model_name:
            fallback_name = f'{brand_nice} {model_name}'.strip()
        else:
            fallback_name = brand_nice or model_number or target['model_id']
        fallback_name = re.sub(r'\s+', ' ', fallback_name).strip()
        catalog_row = {
            'model_id': target['model_id'],
            'store': 'catalog',
            'product_name': fallback_name,
            'price': '',
            'currency': 'USD',
            'url': '',
            'model_number': model_number,
            'fetched_at': now,
            'match_score': '0',
        }
        existing[(catalog_row['model_id'], catalog_row['store'])] = catalog_row
        if kept == 0:
            print(f'  catalog title only: {fallback_name}')
        else:
            print(f'  catalog title: {fallback_name}')

        time.sleep(args.sleep)

    rows = sorted(existing.values(), key=lambda r: (r['model_id'], r['store']))
    write_csv(rows)
    print(f'\nWrote {len(rows)} retail rows → {OUT_CSV}')

    if args.apply_db:
        apply_rows = []
        for row in rows:
            apply_rows.append({
                **row,
                'price': float(row['price']) if row.get('price') not in (None, '') else None,
                'match_score': int(row.get('match_score') or 0),
            })
        apply_to_db(apply_rows)
        print(f'Upserted into {DB_PATH}')


if __name__ == '__main__':
    main()
