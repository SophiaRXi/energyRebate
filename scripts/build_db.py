import sqlite3
import csv
import os

DB_PATH = 'data/rebates.db'
APPLIANCES_CSV = 'data/raw/appliances.csv'
REBATES_CSV = 'data/raw/rebates.csv'

def build_database():
    os.makedirs('data', exist_ok=True)
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Create tables
    cursor.execute('''
        CREATE TABLE appliances (
            model_id TEXT PRIMARY KEY,
            category TEXT,
            brand TEXT,
            efficiency_rating REAL
        )
    ''')

    cursor.execute('''
        CREATE TABLE rebates (
            program_id TEXT PRIMARY KEY,
            zip_code TEXT,
            category TEXT,
            min_efficiency REAL,
            income_cap REAL,
            amount REAL
        )
    ''')

    # Create indexes for fast lookup
    cursor.execute('CREATE INDEX idx_appliances_cat ON appliances(category)')
    cursor.execute('CREATE INDEX idx_rebates_zip_cat ON rebates(zip_code, category)')

    # Load Appliances CSV
    with open(APPLIANCES_CSV, 'r') as f:
        reader = csv.DictReader(f)
        cursor.executemany(
            'INSERT INTO appliances VALUES (:model_id, :category, :brand, :efficiency_rating)',
            reader
        )

    # Load Rebates CSV
    with open(REBATES_CSV, 'r') as f:
        reader = csv.DictReader(f)
        cursor.executemany(
            'INSERT INTO rebates VALUES (:program_id, :zip_code, :category, :min_efficiency, :income_cap, :amount)',
            reader
        )

    conn.commit()
    conn.close()
    print("Database built and indexed successfully.")

if __name__ == '__main__':
    build_database()