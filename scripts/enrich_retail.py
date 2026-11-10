#!/usr/bin/env python3
"""
Periodically enrich appliances with retail product names and store prices.

Home Depot and Lowe's block direct scrapes (HTTP 403). This script uses Bing
Shopping only as a discovery source. It fails closed unless one result card
contains the complete appliance model number, brand, price, and a direct link
to the retailer's product page. This intentionally prefers missing prices to
misattributed prices.

Outputs:
  data/raw/retail_listings.csv

Optional:
  --apply-db   also upsert into data/rebates.db.retail_listings
"""

from __future__ import annotations

import argparse
import base64
import binascii
import csv
import datetime as dt
import html as html_lib
import re
import sqlite3
import ssl
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
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
STORE_HOSTS = {
    'home_depot': ('homedepot.com',),
    'lowes': ('lowes.com',),
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
    matches = re.findall(r'\$\s*(\d[\d,]*(?:\.\d{1,2})?)', text or '')
    if len(matches) != 1:
        return None
    try:
        value = float(matches[0].replace(',', ''))
    except ValueError:
        return None
    if value < 5 or value > 50000:
        return None
    return value


class _HtmlNode:
    def __init__(self, tag: str, attrs: dict[str, str], parent=None):
        self.tag = tag
        self.attrs = attrs
        self.parent = parent
        self.children: list[_HtmlNode] = []
        self.text_parts: list[str] = []


class _DomParser(HTMLParser):
    VOID_TAGS = {
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr',
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _HtmlNode('document', {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = _HtmlNode(tag.lower(), dict(attrs), self.stack[-1])
        self.stack[-1].children.append(node)
        if tag.lower() not in self.VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in self.VOID_TAGS and len(self.stack) > 1:
            self.stack.pop()

    def handle_endtag(self, tag):
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        self.stack[-1].text_parts.append(data)


def walk(node: _HtmlNode):
    yield node
    for child in node.children:
        yield from walk(child)


def node_text(node: _HtmlNode) -> str:
    return ' '.join(part for child in walk(node) for part in child.text_parts).strip()


def node_has_class(node: _HtmlNode, class_name: str) -> bool:
    return class_name.lower() in (node.attrs.get('class') or '').lower().split()


def normalize_identity(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', '', (value or '').lower())


def score_offer(title: str, model_number: str, brand: str) -> int:
    model = normalize_identity(model_number)
    title_key = normalize_identity(title)
    brand_key = normalize_identity(brand)
    if len(model) < 5 or not brand_key:
        return 0
    return 100 if model in title_key and brand_key in title_key else 0


def store_for_url(url: str) -> str | None:
    try:
        parsed = urllib.parse.urlsplit(urllib.parse.urljoin('https://www.bing.com', url))
    except ValueError:
        return None
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname:
        return None
    host = parsed.hostname.lower().rstrip('.')
    if len(parsed.path.strip('/')) < 3:
        return None
    for store, domains in STORE_HOSTS.items():
        if any(host == domain or host.endswith('.' + domain) for domain in domains):
            return store
    return None


def resolve_retailer_url(url: str) -> str:
    """Unwrap Bing's common tracking links and return only an allowed store URL."""
    absolute = urllib.parse.urljoin('https://www.bing.com', html_lib.unescape(url or '').strip())
    if store_for_url(absolute):
        return absolute

    try:
        parsed = urllib.parse.urlsplit(absolute)
    except ValueError:
        return ''
    host = (parsed.hostname or '').lower()
    if host != 'bing.com' and not host.endswith('.bing.com'):
        return ''

    query = urllib.parse.parse_qs(parsed.query)
    candidates = []
    for key in ('u', 'url', 'target', 'r'):
        for value in query.get(key, []):
            value = urllib.parse.unquote(value)
            candidates.append(value)
            if value.startswith('a1'):
                encoded = value[2:]
                encoded += '=' * (-len(encoded) % 4)
                try:
                    candidates.append(base64.urlsafe_b64decode(encoded).decode('utf-8', 'replace'))
                except (ValueError, binascii.Error):
                    continue

    for candidate in candidates:
        candidate = urllib.parse.unquote(candidate)
        if store_for_url(candidate):
            return urllib.parse.urljoin('https://www.bing.com', candidate)
    return ''


def title_link(node: _HtmlNode) -> str:
    current = node
    for _ in range(8):
        if current is None:
            break
        if current.tag == 'a' and current.attrs.get('href'):
            return html_lib.unescape(current.attrs['href']).strip()
        current = current.parent
    for child in walk(node):
        if child.tag == 'a' and child.attrs.get('href'):
            return html_lib.unescape(child.attrs['href']).strip()
    return ''


def parse_bing_shop(html: str) -> list[dict]:
    """Read each title and price from their smallest shared result-card ancestor."""
    parser = _DomParser()
    parser.feed(html)
    offers = []

    for title_node in (n for n in walk(parser.root) if node_has_class(n, 'br-offTtl')):
        title = next(
            (html_lib.unescape(n.attrs['title']).strip() for n in walk(title_node)
             if n.attrs.get('title', '').strip()),
            node_text(title_node),
        )
        if not title:
            continue

        url = resolve_retailer_url(title_link(title_node))
        store = store_for_url(url)
        if not store:
            continue

        current = title_node
        for _ in range(10):
            if current is None:
                break
            descendants = list(walk(current))
            price_node = next((n for n in descendants if node_has_class(n, 'br-price')), None)
            if price_node:
                price = parse_price(node_text(price_node))
                if price is not None:
                    seller_node = next(
                        (n for n in descendants if node_has_class(n, 'br-offSlrTxt')),
                        None,
                    )
                    seller = node_text(seller_node) if seller_node else store
                    seller_store = next(
                        (key for key, pattern in STORES.items() if pattern.search(seller)),
                        None,
                    )
                    if seller_store and seller_store != store:
                        break
                    offers.append({
                        'store': store,
                        'product_name': title,
                        'price': price,
                        'seller': seller,
                        'url': urllib.parse.urljoin('https://www.bing.com', url),
                    })
                    break
            current = current.parent

    return offers


def search_retail(brand: str, model_number: str) -> list[dict]:
    if not brand or not model_number:
        return []
    queries = [
        f'{brand} {model_number}',
        f'{model_number} Home Depot',
        f'{model_number} Lowe\'s',
    ]

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
        offer['score'] = score_offer(offer['product_name'], model_number, brand)
        if offer['score'] < 100 or not store_for_url(offer.get('url', '')):
            continue
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
            SELECT a.model_id, a.brand, a.model_number
            FROM appliances a
            WHERE a.model_id IN ({placeholders})
            ORDER BY a.brand, a.model_id
            """,
            seeds,
        ).fetchall()
    else:
        rows = cur.execute(
            """
            SELECT a.model_id, a.brand, a.model_number
            FROM appliances a
            WHERE a.category IN ('water_heater','heat_pump','induction_stove','electric_cooking')
            ORDER BY CASE WHEN a.model_id LIKE 'es-%' THEN 1 ELSE 0 END, a.brand, a.model_id
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    targets = []
    for r in rows:
        targets.append({
            'model_id': r[0],
            'brand': r[1] or '',
            'model_number': r[2] or '',
        })
    return targets[:limit]


def read_existing_csv() -> dict[tuple[str, str], dict]:
    existing = {}
    if not OUT_CSV.exists():
        return existing
    with OUT_CSV.open('r', encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            model = normalize_identity(row.get('model_number', ''))
            title = normalize_identity(row.get('product_name', ''))
            store = row.get('store', '')
            if (
                store not in STORE_HOSTS
                or not model
                or model not in title
                or row.get('match_score') != '100'
                or store_for_url(row.get('url', '')) != store
                or parse_price(row.get('price', '')) is None
                or not row.get('fetched_at')
            ):
                continue
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
    # The CSV is the reviewed source of truth; remove rows that did not survive
    # validation before applying it to the local database.
    conn.execute('DELETE FROM retail_listings')
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
    args = parser.parse_args()

    if not DB_PATH.exists():
        raise SystemExit(f'Database not found at {DB_PATH}. Run npm run build:db first.')

    conn = sqlite3.connect(DB_PATH)
    targets = load_targets(conn, args.limit, args.seed_only)
    conn.close()

    existing = read_existing_csv()
    print(f'Enriching {len(targets)} appliances via Bing Shopping…')

    for i, target in enumerate(targets, start=1):
        model_number = target['model_number']
        brand = target['brand']
        print(f'[{i}/{len(targets)}] {brand} {model_number or "(no verified model number)"}')
        # Replace prior rows for this model so stale/wrong prices don't linger.
        for key in list(existing):
            if key[0] == target['model_id']:
                existing.pop(key, None)
        try:
            offers = search_retail(
                brand,
                model_number,
            ) if model_number else []
        except Exception as err:  # noqa: BLE001
            print(f'  failed: {err}')
            time.sleep(args.sleep)
            continue

        kept = 0
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
        for offer in offers:
            if (
                offer.get('score') != 100
                or normalize_identity(model_number) not in normalize_identity(offer['product_name'])
                or store_for_url(offer.get('url', '')) != offer.get('store')
            ):
                print(f'  skip unverified {offer["store"]} · {offer["product_name"][:60]}')
                continue
            row = {
                'model_id': target['model_id'],
                'store': offer['store'],
                'product_name': offer['product_name'],
                'price': f'{offer["price"]:.2f}',
                'currency': 'USD',
                'url': offer['url'],
                'model_number': model_number,
                'fetched_at': now,
                'match_score': '100',
            }
            existing[(row['model_id'], row['store'])] = row
            kept += 1
            print(f'  {offer["store"]}: ${offer["price"]:.2f} · {offer["product_name"][:70]}')

        if kept == 0:
            print('  no verified retailer offer; product identity remains in the appliance catalog')

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
