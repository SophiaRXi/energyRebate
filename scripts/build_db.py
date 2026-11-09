import sqlite3
import csv
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

DB_PATH = os.path.join(PROJECT_ROOT, 'data', 'rebates.db')
RAW_DIR = os.path.join(PROJECT_ROOT, 'data', 'raw')

os.makedirs(os.path.join(PROJECT_ROOT, 'data'), exist_ok=True)

if os.path.exists(DB_PATH):
    os.remove(DB_PATH)

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

cursor.execute('CREATE INDEX idx_attr_model ON appliance_attributes(model_id)')
cursor.execute('CREATE INDEX idx_rebate_lookup ON rebates(zip_code, category)')
cursor.execute('CREATE INDEX idx_req_program ON rebate_requirements(program_id)')

appliance_file = os.path.join(RAW_DIR, 'appliances.csv')
with open(appliance_file, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for r in reader:
        cursor.execute(
            'INSERT INTO appliances VALUES (?, ?, ?)',
            (r['model_id'].strip().lower(), r['category'].strip().lower(), r['brand'].strip())
        )

attr_file = next(
    (p for p in (
        os.path.join(RAW_DIR, 'appliance_attributes.csv'),
        os.path.join(RAW_DIR, 'appliance_attributes'),
    ) if os.path.exists(p)),
    None,
)
if attr_file:
    with open(attr_file, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            cursor.execute(
                'INSERT INTO appliance_attributes VALUES (?, ?, ?)',
                (
                    r['model_id'].strip().lower(),
                    r['attribute_name'].strip().lower(),
                    r['attribute_value'].strip().lower(),
                )
            )

rebates_file = os.path.join(RAW_DIR, 'rebates.csv')
with open(rebates_file, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for r in reader:
        cursor.execute(
            'INSERT INTO rebates VALUES (?, ?, ?, ?, ?)',
            (
                r['program_id'].strip().lower(),
                str(r['zip_code']).strip(),
                r['category'].strip().lower(),
                float(r['income_cap']),
                float(r['amount']),
            )
        )

req_file = os.path.join(RAW_DIR, 'rebate_requirements.csv')
if os.path.exists(req_file):
    with open(req_file, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            cursor.execute(
                'INSERT INTO rebate_requirements VALUES (?, ?, ?, ?)',
                (
                    r['program_id'].strip().lower(),
                    r['attribute_name'].strip().lower(),
                    r['operator'].strip().lower(),
                    r['attribute_value'].strip().lower(),
                )
            )

conn.commit()
conn.close()
print(f"Database successfully built at: {DB_PATH}")
