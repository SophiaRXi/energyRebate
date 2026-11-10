#!/usr/bin/env python3
"""
Normalize downloaded ENERGY STAR CSVs into a compact local catalog.

Outputs:
  data/raw/energystar/normalized/appliances.csv

Each row stores only rebate-relevant categories and a slim attrs_json blob so the
local SQLite build stays small while remaining easy to move to a hosted DB later.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from catalog_config import (  # noqa: E402
    ALLOWED_ATTRIBUTES,
    ALLOWED_CATEGORIES,
    category_from_dataset,
)

ES_DIR = PROJECT_ROOT / 'data' / 'raw' / 'energystar'
MANIFEST_PATH = ES_DIR / 'manifest.json'
OUT_DIR = ES_DIR / 'normalized'

ATTRIBUTE_ALIASES = {
    'uniform energy factor uef': 'uef',
    'uniform energy factor': 'uef',
    'seer2 btu wh': 'seer2',
    'seer2': 'seer2',
    'eer2 btu wh': 'eer2',
    'hspf2 btu wh': 'hspf2',
    'combined energy efficiency ratio ceer': 'ceer',
    'integrated modified energy factor imef': 'imef',
    'integrated water factor iwf': 'iwf',
    'combined energy factor cef': 'cef',
    'vent type': 'vent',
    'storage volume gallons': 'storage_volume',
    'first hour rating gallons': 'fhr_rating',
    'draw pattern intended usage': 'draw_pattern',
    'recovery efficiency': 'recovery_efficiency',
    'recovery efficiency %': 'recovery_efficiency',
    'cooking top technology': 'cooking_top_technology',
    'product type': 'product_type',
    'type': 'type',
    'fuel': 'fuel',
    'heat pump type': 'heat_pump_type',
    'cold climate': 'cold_climate',
}

SKIP_ATTRIBUTES = {
    'energy_star_unique_id',
    'energy_star_partner',
    'brand_name',
    'brand',
    'model_name',
    'model_number',
    'outdoor_unit_brand_name',
    'outdoor_unit_model_number',
    'indoor_unit_brand_name',
    'indoor_unit_model_number',
    'additional_model_information',
    'upc',
    'cb_model_identifier',
    'date_available_on_market',
    'date_certified',
    'markets',
    'pdf_url',
}

VENT_ALIASES = {
    'power': 'power',
    'power vent': 'power',
    'power vented': 'power',
    'power-vented': 'power',
    'direct': 'direct',
    'direct vent': 'direct',
    'direct-vent': 'direct',
    'atmospheric': 'atmospheric',
    'natural': 'atmospheric',
}


def slug_attr(name: str) -> str:
    key = re.sub(r'[^a-z0-9]+', ' ', name.lower()).strip()
    key = re.sub(r'\s+', ' ', key)
    if key in ATTRIBUTE_ALIASES:
        return ATTRIBUTE_ALIASES[key]
    return re.sub(r'[^a-z0-9]+', '_', key).strip('_')


def pick_column(fieldnames: list[str], *candidates: str) -> str | None:
    lower_map = {f.lower().strip(): f for f in fieldnames}
    for candidate in candidates:
        if candidate.lower() in lower_map:
            return lower_map[candidate.lower()]
    return None


def clean_value(value: str) -> str:
    text = (value or '').strip()
    if not text or text.lower() in {'n/a', 'na', 'none', 'null', '-'}:
        return ''
    text = text.replace(',', '')
    return text.lower()


def put_attr(attrs: dict, name: str, value: str) -> None:
    if name not in ALLOWED_ATTRIBUTES or not value:
        return
    existing = attrs.get(name)
    if existing is None:
        attrs[name] = value
        return
    if isinstance(existing, list):
        if value not in existing:
            existing.append(value)
        return
    if existing != value:
        attrs[name] = [existing, value]


def load_manifest() -> list[dict]:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text())
    items = []
    for path in sorted(ES_DIR.glob('*.csv')):
        items.append({
            'id': path.stem,
            'name': f'ENERGY STAR Certified {path.stem.replace("_", " ").title()}',
            'file': path.name,
            'path': str(path.relative_to(PROJECT_ROOT)),
        })
    return items


def import_dataset(item: dict, appliances: list[dict], seen_ids: set[str]) -> tuple[int, int, bool]:
    path = PROJECT_ROOT / item['path'] if item.get('path') else ES_DIR / item['file']
    if not path.exists():
        print(f'  missing file: {path}')
        return 0, 0, False

    category = category_from_dataset(item['name'])
    if category not in ALLOWED_CATEGORIES:
        return 0, 0, False

    rows_in = 0
    rows_kept = 0

    with path.open('r', encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            return 0, 0, True

        brand_col = pick_column(
            reader.fieldnames,
            'Brand Name',
            'Outdoor Unit Brand Name',
            'Indoor Unit Brand Name',
            'Brand',
        )
        model_col = pick_column(
            reader.fieldnames,
            'Model Number',
            'Outdoor Unit Model Number',
            'Indoor Unit Model Number',
            'Model Name',
        )
        es_id_col = pick_column(reader.fieldnames, 'ENERGY STAR Unique ID')
        model_name_col = pick_column(reader.fieldnames, 'Model Name', 'Series Name')

        for row in reader:
            rows_in += 1
            es_id = clean_value(row.get(es_id_col, '')) if es_id_col else ''
            brand = clean_value(row.get(brand_col, '')) if brand_col else ''
            model_number = clean_value(row.get(model_col, '')) if model_col else ''
            model_name = clean_value(row.get(model_name_col, '')) if model_name_col else ''

            if not es_id and not model_number:
                continue

            model_id = f'es-{es_id}' if es_id else re.sub(
                r'[^a-z0-9._+-]+', '_', f'{brand}_{model_number}'.strip('_')
            )
            if model_id in seen_ids:
                continue
            seen_ids.add(model_id)

            attrs: dict = {}
            put_attr(attrs, 'model_number', model_number)
            put_attr(attrs, 'model_name', model_name)
            put_attr(attrs, 'energystar_id', es_id)
            put_attr(attrs, 'energystar_dataset', category)

            value_map: dict[str, str] = {}
            for col, raw in row.items():
                if not col:
                    continue
                attr_name = slug_attr(col)
                if attr_name in SKIP_ATTRIBUTES:
                    continue
                value = clean_value(raw)
                if not value:
                    continue
                put_attr(attrs, attr_name, value)
                value_map[attr_name] = value

                if attr_name == 'vent':
                    for piece in re.split(r'[/|,;]+', value):
                        alias = VENT_ALIASES.get(piece.strip())
                        if alias:
                            put_attr(attrs, 'vent', alias)

            if 'uef' in value_map:
                put_attr(attrs, 'efficiency', value_map['uef'])
            elif 'seer2' in value_map:
                put_attr(attrs, 'efficiency', value_map['seer2'])
            elif 'ceer' in value_map:
                put_attr(attrs, 'efficiency', value_map['ceer'])
            elif 'imef' in value_map:
                put_attr(attrs, 'efficiency', value_map['imef'])

            cooking_tech = value_map.get('cooking_top_technology', '')
            if 'induction' in cooking_tech:
                put_attr(attrs, 'cooking_top_technology', 'induction')

            appliances.append({
                'model_id': model_id,
                'category': category,
                'brand': brand or 'unknown',
                'model_number': model_number,
                'attrs_json': json.dumps(attrs, separators=(',', ':')),
            })
            rows_kept += 1

    return rows_in, rows_kept, True


def main() -> None:
    manifest = load_manifest()
    if not manifest:
        raise SystemExit(
            f'No ENERGY STAR CSVs found in {ES_DIR}. Run: python3 scripts/fetch_energystar.py'
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    appliances: list[dict] = []
    seen_ids: set[str] = set()

    print(f'Importing ENERGY STAR datasets (allowed categories only)…')
    skipped = 0
    for item in manifest:
        rows_in, rows_kept, used = import_dataset(item, appliances, seen_ids)
        if not used:
            skipped += 1
            print(f'  skip {item["name"]}')
            continue
        print(f'  {item["name"]}: kept {rows_kept:,} / {rows_in:,}')

    appliances_path = OUT_DIR / 'appliances.csv'
    with appliances_path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=['model_id', 'category', 'brand', 'model_number', 'attrs_json'],
        )
        writer.writeheader()
        writer.writerows(appliances)

    # Remove legacy flat attribute dump if present (can be hundreds of MB).
    legacy_attrs = OUT_DIR / 'appliance_attributes.csv'
    if legacy_attrs.exists():
        legacy_attrs.unlink()
        print(f'Removed legacy {legacy_attrs}')

    print(f'\nSkipped {skipped} non-rebate datasets')
    print(f'Wrote {len(appliances):,} appliances → {appliances_path}')


if __name__ == '__main__':
    main()
