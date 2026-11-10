#!/usr/bin/env python3
"""Build data/rebates.db from seed CSVs plus normalized ENERGY STAR imports."""

from __future__ import annotations

import csv
import os
import sqlite3
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
DB_PATH = PROJECT_ROOT / 'data' / 'rebates.db'
RAW_DIR = PROJECT_ROOT / 'data' / 'raw'
ES_NORMALIZED = RAW_DIR / 'energystar' / 'normalized'

os.makedirs(PROJECT_ROOT / 'data', exist_ok=True)

if DB_PATH.exists():
    DB_PATH.unlink()

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

cursor.execute('''
CREATE TABLE appliances (
    model_id TEXT PRIMARY KEY,
    category TEXT,
    brand TEXT
)
''')

cursor.execute('''
CREATE TABLE appliance_attributes (
    model_id TEXT,
    attribute_name TEXT,
    attribute_value TEXT
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

cursor.execute('CREATE INDEX idx_attr_model ON appliance_attributes(model_id)')
cursor.execute('CREATE INDEX idx_attr_name_value ON appliance_attributes(attribute_name, attribute_value)')
cursor.execute('CREATE INDEX idx_rebate_lookup ON rebates(zip_code, category)')
cursor.execute('CREATE INDEX idx_req_program ON rebate_requirements(program_id)')
cursor.execute('CREATE INDEX idx_appliances_category ON appliances(category)')
cursor.execute('CREATE INDEX idx_retail_model ON retail_listings(model_id)')


def load_appliances(path: Path, seen: set[str]) -> int:
    if not path.exists():
        return 0
    count = 0
    with path.open('r', encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            model_id = row['model_id'].strip().lower()
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            cursor.execute(
                'INSERT INTO appliances VALUES (?, ?, ?)',
                (model_id, row['category'].strip().lower(), row['brand'].strip())
            )
            count += 1
    return count


def load_attributes(path: Path, valid_models: set[str]) -> int:
    if not path.exists():
        return 0
    count = 0
    with path.open('r', encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        batch = []
        for row in reader:
            model_id = row['model_id'].strip().lower()
            if model_id not in valid_models:
                continue
            batch.append((
                model_id,
                row['attribute_name'].strip().lower(),
                row['attribute_value'].strip().lower(),
            ))
            if len(batch) >= 1000:
                cursor.executemany('INSERT INTO appliance_attributes VALUES (?, ?, ?)', batch)
                count += len(batch)
                batch.clear()
        if batch:
            cursor.executemany('INSERT INTO appliance_attributes VALUES (?, ?, ?)', batch)
            count += len(batch)
    return count


seen_models: set[str] = set()

# Seed fixtures first so tests keep stable hand-authored model ids.
seed_appliances = RAW_DIR / 'appliances.csv'
seed_attrs = next(
    (p for p in (RAW_DIR / 'appliance_attributes.csv', RAW_DIR / 'appliance_attributes') if p.exists()),
    None,
)

seed_count = load_appliances(seed_appliances, seen_models)
print(f'Loaded {seed_count:,} seed appliances')

es_count = load_appliances(ES_NORMALIZED / 'appliances.csv', seen_models)
print(f'Loaded {es_count:,} ENERGY STAR appliances')

attr_count = 0
if seed_attrs:
    attr_count += load_attributes(seed_attrs, seen_models)
attr_count += load_attributes(ES_NORMALIZED / 'appliance_attributes.csv', seen_models)
print(f'Loaded {attr_count:,} appliance attributes')

rebates_file = RAW_DIR / 'rebates.csv'
with rebates_file.open('r', encoding='utf-8', newline='') as handle:
    reader = csv.DictReader(handle)
    for row in reader:
        cursor.execute(
            'INSERT INTO rebates VALUES (?, ?, ?, ?, ?)',
            (
                row['program_id'].strip().lower(),
                str(row['zip_code']).strip(),
                row['category'].strip().lower(),
                float(row['income_cap']),
                float(row['amount']),
            )
        )

req_file = RAW_DIR / 'rebate_requirements.csv'
if req_file.exists():
    with req_file.open('r', encoding='utf-8', newline='') as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            cursor.execute(
                'INSERT INTO rebate_requirements VALUES (?, ?, ?, ?)',
                (
                    row['program_id'].strip().lower(),
                    row['attribute_name'].strip().lower(),
                    row['operator'].strip().lower(),
                    row['attribute_value'].strip().lower(),
                )
            )

retail_file = RAW_DIR / 'retail_listings.csv'
retail_count = 0
if retail_file.exists():
    with retail_file.open('r', encoding='utf-8', newline='') as handle:
        reader = csv.DictReader(handle)
        for row in reader:
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
                )
            )
            retail_count += 1
print(f'Loaded {retail_count:,} retail listings')

conn.commit()
totals = {
    'appliances': cursor.execute('SELECT COUNT(*) FROM appliances').fetchone()[0],
    'attributes': cursor.execute('SELECT COUNT(*) FROM appliance_attributes').fetchone()[0],
    'rebates': cursor.execute('SELECT COUNT(*) FROM rebates').fetchone()[0],
    'requirements': cursor.execute('SELECT COUNT(*) FROM rebate_requirements').fetchone()[0],
    'retail_listings': cursor.execute('SELECT COUNT(*) FROM retail_listings').fetchone()[0],
}
conn.close()
print(f"Database successfully built at: {DB_PATH}")
print(f"Totals: {totals}")
