#!/usr/bin/env python3
"""
Normalize downloaded ENERGY STAR CSVs into appliances + attribute rows.

Outputs:
  data/raw/energystar/normalized/appliances.csv
  data/raw/energystar/normalized/appliance_attributes.csv
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
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
    'annual energy use kwh yr': 'annual_energy_use_kwh',
    'annual energy consumption kwh year': 'annual_energy_use_kwh',
    'cooling capacity btu h': 'cooling_capacity_btu',
    'cooling capacity btu hr': 'cooling_capacity_btu',
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


def category_from_dataset(name: str) -> str:
    text = name.lower()
    text = re.sub(r'^energy star certified\s+', '', text)
    text = re.sub(r'\s+v\d+(\.\d+)?$', '', text)
    slug = re.sub(r'[^a-z0-9]+', '_', text).strip('_')

    # Collapse ENERGY STAR dataset names onto the category ids used by rebates.
    if 'water_heater' in slug:
        return 'water_heater'
    if 'geothermal_heat_pump' in slug:
        return 'geothermal_heat_pump'
    if 'heat_pump' in slug:
        return 'heat_pump'
    if 'electric_cooking' in slug:
        return 'electric_cooking'
    if 'room_air_conditioner' in slug:
        return 'room_air_conditioner'
    if 'residential_clothes_washer' in slug or slug == 'commercial_clothes_washers':
        return 'clothes_washer'
    if 'residential_dishwasher' in slug or 'commercial_dishwasher' in slug:
        return 'dishwasher'
    if 'residential_refrigerator' in slug:
        return 'refrigerator'
    if 'residential_freezer' in slug:
        return 'freezer'
    return slug


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


def add_attr(bucket: list[dict], model_id: str, name: str, value: str, seen: set[tuple[str, str]]) -> None:
    key = (name, value)
    if not value or key in seen:
        return
    seen.add(key)
    bucket.append({
        'model_id': model_id,
        'attribute_name': name,
        'attribute_value': value,
    })


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


def import_dataset(item: dict, appliances: list[dict], attributes: list[dict], seen_ids: set[str]) -> tuple[int, int]:
    path = PROJECT_ROOT / item['path'] if item.get('path') else ES_DIR / item['file']
    if not path.exists():
        print(f'  missing file: {path}')
        return 0, 0

    category = category_from_dataset(item['name'])
    rows_in = 0
    rows_kept = 0

    with path.open('r', encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            return 0, 0

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

            model_id = f'es-{es_id}' if es_id else re.sub(r'[^a-z0-9._+-]+', '_', f'{brand}_{model_number}'.strip('_'))
            if model_id in seen_ids:
                continue
            seen_ids.add(model_id)

            appliances.append({
                'model_id': model_id,
                'category': category,
                'brand': brand or 'unknown',
            })

            row_attrs: list[dict] = []
            seen_attr_keys: set[tuple[str, str]] = set()

            add_attr(row_attrs, model_id, 'model_number', model_number, seen_attr_keys)
            add_attr(row_attrs, model_id, 'model_name', model_name, seen_attr_keys)
            add_attr(row_attrs, model_id, 'energystar_id', es_id, seen_attr_keys)
            add_attr(row_attrs, model_id, 'energystar_dataset', category, seen_attr_keys)

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
                add_attr(row_attrs, model_id, attr_name, value, seen_attr_keys)
                value_map[attr_name] = value

                if attr_name == 'vent':
                    for piece in re.split(r'[/|,;]+', value):
                        piece = piece.strip()
                        alias = VENT_ALIASES.get(piece)
                        if alias:
                            add_attr(row_attrs, model_id, 'vent', alias, seen_attr_keys)

            if 'uef' in value_map:
                add_attr(row_attrs, model_id, 'efficiency', value_map['uef'], seen_attr_keys)
            elif 'seer2' in value_map:
                add_attr(row_attrs, model_id, 'efficiency', value_map['seer2'], seen_attr_keys)
            elif 'ceer' in value_map:
                add_attr(row_attrs, model_id, 'efficiency', value_map['ceer'], seen_attr_keys)
            elif 'imef' in value_map:
                add_attr(row_attrs, model_id, 'efficiency', value_map['imef'], seen_attr_keys)

            # Map cooking products that are induction into a category-friendly tag.
            cooking_tech = value_map.get('cooking_top_technology', '')
            if 'induction' in cooking_tech:
                add_attr(row_attrs, model_id, 'cooking_top_technology', 'induction', seen_attr_keys)

            attributes.extend(row_attrs)
            rows_kept += 1

    return rows_in, rows_kept


def main() -> None:
    manifest = load_manifest()
    if not manifest:
        raise SystemExit(
            f'No ENERGY STAR CSVs found in {ES_DIR}. Run: python3 scripts/fetch_energystar.py'
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    appliances: list[dict] = []
    attributes: list[dict] = []
    seen_ids: set[str] = set()

    print(f'Importing {len(manifest)} ENERGY STAR datasets…')
    for item in manifest:
        rows_in, rows_kept = import_dataset(item, appliances, attributes, seen_ids)
        print(f'  {item["name"]}: kept {rows_kept:,} / {rows_in:,}')

    appliances_path = OUT_DIR / 'appliances.csv'
    attributes_path = OUT_DIR / 'appliance_attributes.csv'

    with appliances_path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['model_id', 'category', 'brand'])
        writer.writeheader()
        writer.writerows(appliances)

    with attributes_path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['model_id', 'attribute_name', 'attribute_value'])
        writer.writeheader()
        writer.writerows(attributes)

    print(f'\nWrote {len(appliances):,} appliances → {appliances_path}')
    print(f'Wrote {len(attributes):,} attributes → {attributes_path}')


if __name__ == '__main__':
    main()
