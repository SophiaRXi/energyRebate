"""
Shared catalog settings for local ENERGY STAR import/build.

Kept intentionally simple and file-based so a future hosted DB (Turso/Postgres)
can reuse the same category/attribute allowlists without changing app logic.
"""

from __future__ import annotations

import re

# Only rebate-relevant product families. Everything else is skipped at fetch/import.
ALLOWED_CATEGORIES = {
    'heat_pump',
    'geothermal_heat_pump',
    'water_heater',
    'electric_cooking',
    'induction_stove',
    'room_air_conditioner',
    'clothes_washer',
    'dishwasher',
    'refrigerator',
    'freezer',
}

# Identity + eligibility/display fields only. Do not store every ENERGY STAR column.
ALLOWED_ATTRIBUTES = {
    'model_number',
    'model_name',
    'ahri_reference_number',
    'energystar_id',
    'energystar_dataset',
    'uef',
    'seer2',
    'eer2',
    'hspf2',
    'ceer',
    'imef',
    'efficiency',
    'vent',
    'storage_volume',
    'draw_pattern',
    'fhr_rating',
    'recovery_efficiency',
    'cooking_top_technology',
    'fuel',
    'type',
    'product_type',
    'heat_pump_type',
    'cold_climate',
}

# Numeric fields promoted to indexed REAL columns for fast eligibility filters.
METRIC_COLUMNS = ('uef', 'seer2', 'eer2', 'hspf2', 'ceer', 'imef', 'efficiency')


def category_from_dataset(name: str) -> str:
    text = name.lower()
    text = re.sub(r'^energy star certified\s+', '', text)
    text = re.sub(r'\s+v\d+(\.\d+)?$', '', text)
    slug = re.sub(r'[^a-z0-9]+', '_', text).strip('_')

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


def is_allowed_dataset(name: str) -> bool:
    return category_from_dataset(name) in ALLOWED_CATEGORIES
