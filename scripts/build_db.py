#!/usr/bin/env python3
"""Build data/rebates.db from seed CSVs plus normalized ENERGY STAR imports.

Appliances store a slim attrs_json blob plus indexed metric columns so the local
file stays small. Swap DATABASE_PATH / DATABASE_URL later without changing rules.
"""

from __future__ import annotations

import csv
import json
import os
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from catalog_config import METRIC_COLUMNS  # noqa: E402

DB_PATH = Path(os.environ.get('DATABASE_PATH') or PROJECT_ROOT / 'data' / 'rebates.db')
RAW_DIR = PROJECT_ROOT / 'data' / 'raw'
ES_NORMALIZED = RAW_DIR / 'energystar' / 'normalized'

os.makedirs(DB_PATH.parent, exist_ok=True)

if DB_PATH.exists():
    DB_PATH.unlink()

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

metric_defs = ',\n    '.join(f'{name} REAL' for name in METRIC_COLUMNS)

cursor.execute(f'''
CREATE TABLE appliances (
    model_id TEXT PRIMARY KEY,
    category TEXT,
    brand TEXT,
    model_number TEXT,
    energystar_id TEXT,
    vent TEXT,
    cooking_top_technology TEXT,
    attrs_json TEXT NOT NULL DEFAULT '{{}}',
    {metric_defs}
)
''')

cursor.execute('''
CREATE TABLE rebates (
    program_id TEXT PRIMARY KEY,
    zip_code TEXT,
    category TEXT,
    income_cap REAL,
    amount REAL
)
''')

cursor.execute('''
CREATE TABLE rebate_requirements (
    program_id TEXT,
    attribute_name TEXT,
    operator TEXT,
    attribute_value TEXT
)
''')

cursor.execute('''
CREATE TABLE retail_listings (
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
''')

cursor.execute('CREATE INDEX idx_rebate_lookup ON rebates(zip_code, category)')
cursor.execute('CREATE INDEX idx_req_program ON rebate_requirements(program_id)')
cursor.execute('CREATE INDEX idx_appliances_category ON appliances(category)')
cursor.execute('CREATE INDEX idx_appliances_model_number ON appliances(model_number)')
cursor.execute('CREATE INDEX idx_appliances_es_id ON appliances(energystar_id)')
cursor.execute('CREATE INDEX idx_appliances_uef ON appliances(uef)')
cursor.execute('CREATE INDEX idx_appliances_seer2 ON appliances(seer2)')
cursor.execute('CREATE INDEX idx_appliances_efficiency ON appliances(efficiency)')
cursor.execute('CREATE INDEX idx_appliances_vent ON appliances(vent)')
cursor.execute('CREATE INDEX idx_retail_model ON retail_listings(model_id)')


def to_float(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(',', '')
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def first_scalar(value):
    if isinstance(value, list):
        return value[0] if value else None
    return value


def vent_text(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        parts = [str(v).strip().lower() for v in value if str(v).strip()]
        return '|'.join(dict.fromkeys(parts)) or None
    text = str(value).strip().lower()
    return text or None


def attrs_from_eav(rows: list[tuple[str, str]]) -> dict:
    attrs: dict = {}
    for name, value in rows:
        name = name.strip().lower()
        value = value.strip().lower()
        if not name or not value:
            continue
        existing = attrs.get(name)
        if existing is None:
            attrs[name] = value
        elif isinstance(existing, list):
            if value not in existing:
                existing.append(value)
        elif existing != value:
            attrs[name] = [existing, value]
    return attrs


def insert_appliance(model_id: str, category: str, brand: str, attrs: dict) -> None:
    model_number = first_scalar(attrs.get('model_number'))
    energystar_id = first_scalar(attrs.get('energystar_id'))
    cooking = first_scalar(attrs.get('cooking_top_technology'))
    metrics = [to_float(first_scalar(attrs.get(name))) for name in METRIC_COLUMNS]
    cursor.execute(
        f'''
        INSERT INTO appliances (
            model_id, category, brand, model_number, energystar_id, vent,
            cooking_top_technology, attrs_json, {", ".join(METRIC_COLUMNS)}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, {", ".join("?" for _ in METRIC_COLUMNS)})
        ''',
        (
            model_id,
            category,
            brand,
            str(model_number).lower() if model_number else None,
            str(energystar_id).lower() if energystar_id else None,
            vent_text(attrs.get('vent')),
            str(cooking).lower() if cooking else None,
            json.dumps(attrs, separators=(',', ':')),
            *metrics,
        ),
    )


def load_seed_appliances(path: Path, attr_path: Path | None, seen: set[str]) -> int:
    if not path.exists():
        return 0

    attrs_by_model: dict[str, list[tuple[str, str]]] = {}
    if attr_path and attr_path.exists():
        with attr_path.open('r', encoding='utf-8-sig', newline='') as handle:
            for row in csv.DictReader(handle):
                model_id = row['model_id'].strip().lower()
                attrs_by_model.setdefault(model_id, []).append(
                    (row['attribute_name'], row['attribute_value'])
                )

    count = 0
    with path.open('r', encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            model_id = row['model_id'].strip().lower()
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            attrs = attrs_from_eav(attrs_by_model.get(model_id, []))
            if 'model_number' not in attrs:
                attrs['model_number'] = model_id
            insert_appliance(
                model_id,
                row['category'].strip().lower(),
                row['brand'].strip(),
                attrs,
            )
            count += 1
    return count


def load_es_appliances(path: Path, seen: set[str]) -> int:
    if not path.exists():
        return 0
    count = 0
    with path.open('r', encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            model_id = row['model_id'].strip().lower()
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            raw = (row.get('attrs_json') or '{}').strip() or '{}'
            try:
                attrs = json.loads(raw)
            except json.JSONDecodeError:
                attrs = {}
            if not isinstance(attrs, dict):
                attrs = {}
            if row.get('model_number') and 'model_number' not in attrs:
                attrs['model_number'] = row['model_number'].strip().lower()
            insert_appliance(
                model_id,
                row['category'].strip().lower(),
                row['brand'].strip(),
                attrs,
            )
            count += 1
    return count


seen_models: set[str] = set()

seed_appliances = RAW_DIR / 'appliances.csv'
seed_attrs = next(
    (p for p in (RAW_DIR / 'appliance_attributes.csv', RAW_DIR / 'appliance_attributes') if p.exists()),
    None,
)

seed_count = load_seed_appliances(seed_appliances, seed_attrs, seen_models)
print(f'Loaded {seed_count:,} seed appliances')

es_count = load_es_appliances(ES_NORMALIZED / 'appliances.csv', seen_models)
print(f'Loaded {es_count:,} ENERGY STAR appliances')

rebates_file = RAW_DIR / 'rebates.csv'
with rebates_file.open('r', encoding='utf-8', newline='') as handle:
    for row in csv.DictReader(handle):
        cursor.execute(
            'INSERT INTO rebates VALUES (?, ?, ?, ?, ?)',
            (
                row['program_id'].strip().lower(),
                str(row['zip_code']).strip(),
                row['category'].strip().lower(),
                float(row['income_cap']),
                float(row['amount']),
            ),
        )

req_file = RAW_DIR / 'rebate_requirements.csv'
if req_file.exists():
    with req_file.open('r', encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            cursor.execute(
                'INSERT INTO rebate_requirements VALUES (?, ?, ?, ?)',
                (
                    row['program_id'].strip().lower(),
                    row['attribute_name'].strip().lower(),
                    row['operator'].strip().lower(),
                    row['attribute_value'].strip().lower(),
                ),
            )

retail_file = RAW_DIR / 'retail_listings.csv'
retail_count = 0
if retail_file.exists():
    with retail_file.open('r', encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            model_id = row['model_id'].strip().lower()
            if model_id not in seen_models:
                continue
            price_raw = (row.get('price') or '').strip()
            price = float(price_raw) if price_raw else None
            cursor.execute(
                'INSERT OR REPLACE INTO retail_listings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (
                    model_id,
                    row['store'].strip().lower(),
                    row.get('product_name', '').strip(),
                    price,
                    (row.get('currency') or 'USD').strip(),
                    row.get('url', '').strip(),
                    row.get('model_number', '').strip(),
                    row.get('fetched_at', '').strip(),
                    int(row.get('match_score') or 0),
                ),
            )
            retail_count += 1
print(f'Loaded {retail_count:,} retail listings')

conn.commit()
cursor.execute('VACUUM')
conn.commit()

totals = {
    'appliances': cursor.execute('SELECT COUNT(*) FROM appliances').fetchone()[0],
    'rebates': cursor.execute('SELECT COUNT(*) FROM rebates').fetchone()[0],
    'requirements': cursor.execute('SELECT COUNT(*) FROM rebate_requirements').fetchone()[0],
    'retail_listings': cursor.execute('SELECT COUNT(*) FROM retail_listings').fetchone()[0],
}
size_mb = DB_PATH.stat().st_size / (1024 * 1024)
conn.close()
print(f'Database successfully built at: {DB_PATH}')
print(f'Size: {size_mb:.1f} MB')
print(f'Totals: {totals}')
