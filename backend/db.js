const Database = require('better-sqlite3');
const config = require('./config');

// Local SQLite today. When DATABASE_URL is set later, swap the client here and
// keep the exported helpers stable for engine/server.
const db = new Database(config.databasePath);

const METRIC_COLUMNS = new Set([
  'uef', 'seer2', 'eer2', 'hspf2', 'ceer', 'imef', 'efficiency'
]);

function expandAttrsJson(modelId, attrsJson, attributeNames = null) {
  let attrs;
  try {
    attrs = JSON.parse(attrsJson || '{}');
  } catch {
    attrs = {};
  }
  if (!attrs || typeof attrs !== 'object') return [];

  const wanted = attributeNames ? new Set(attributeNames.map(n => String(n).toLowerCase())) : null;
  const rows = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (wanted && !wanted.has(name)) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === null || item === undefined || item === '') continue;
        rows.push({ model_id: modelId, attribute_name: name, attribute_value: String(item) });
      }
    } else if (value !== null && value !== undefined && value !== '') {
      rows.push({ model_id: modelId, attribute_name: name, attribute_value: String(value) });
    }
  }
  return rows;
}

function findAppliance(modelId) {
  const key = String(modelId).trim();
  if (!key) return null;

  let appliance = db.prepare(
    `SELECT model_id, category, brand, attrs_json
     FROM appliances
     WHERE LOWER(model_id) = LOWER(?)`
  ).get(key);

  if (appliance) return appliance;

  const byModelNumber = db.prepare(
    `SELECT model_id, category, brand, attrs_json
     FROM appliances
     WHERE LOWER(model_number) = LOWER(?)
     LIMIT 1`
  ).get(key);

  if (byModelNumber) return byModelNumber;

  return db.prepare(
    `SELECT model_id, category, brand, attrs_json
     FROM appliances
     WHERE LOWER(energystar_id) = LOWER(?)
     LIMIT 1`
  ).get(key) || null;
}

function getCandidateFacts(modelId, zipCode) {
  const appliance = findAppliance(modelId);
  if (!appliance) return null;

  const attributes = expandAttrsJson(appliance.model_id, appliance.attrs_json);
  const categoryAliases = categoryAliasesFor(appliance.category, attributes);
  const placeholders = categoryAliases.map(() => '?').join(', ');
  const candidateRebates = db.prepare(
    `SELECT program_id, zip_code, category, income_cap, amount
     FROM rebates
     WHERE CAST(zip_code AS TEXT) = ? AND category IN (${placeholders})`
  ).all(String(zipCode), ...categoryAliases);

  const requirements = getRequirementsForPrograms(candidateRebates.map(r => r.program_id));
  return {
    appliance: {
      model_id: appliance.model_id,
      category: appliance.category,
      brand: appliance.brand
    },
    attributes,
    candidateRebates,
    requirements
  };
}

function getRequirementsForPrograms(programIds) {
  if (!programIds || programIds.length === 0) return [];
  const placeholders = programIds.map(() => '?').join(', ');
  return db.prepare(
    `SELECT program_id, attribute_name, operator, attribute_value
     FROM rebate_requirements
     WHERE program_id IN (${placeholders})`
  ).all(...programIds);
}

function getProgramsForZip(zipCode, category = null) {
  if (category) {
    return db.prepare(
      `SELECT program_id, zip_code, category, income_cap, amount
       FROM rebates
       WHERE CAST(zip_code AS TEXT) = ? AND LOWER(category) = LOWER(?)`
    ).all(String(zipCode), String(category));
  }
  return db.prepare(
    `SELECT program_id, zip_code, category, income_cap, amount
     FROM rebates
     WHERE CAST(zip_code AS TEXT) = ?
     ORDER BY category, program_id`
  ).all(String(zipCode));
}

function categoriesMatchingRebate(rebateCategory) {
  const cat = String(rebateCategory || '').toLowerCase();
  if (cat === 'heat_pump') return ['heat_pump'];
  if (cat === 'water_heater') return ['water_heater'];
  if (cat === 'induction_stove') return ['induction_stove', 'electric_cooking'];
  return [cat];
}

function safeAttrName(name) {
  const attr = String(name || '').toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(attr)) {
    throw new Error(`Unsupported attribute name: ${name}`);
  }
  return attr;
}

function appendRequirementFilters(sql, params, requirements) {
  for (const req of requirements || []) {
    const attr = safeAttrName(req.attribute_name);
    const value = String(req.attribute_value).toLowerCase();
    if (req.operator === 'gte') {
      if (METRIC_COLUMNS.has(attr)) {
        sql += ` AND a.${attr} IS NOT NULL AND a.${attr} >= CAST(? AS REAL)`;
        params.push(value);
      } else {
        sql += ` AND CAST(json_extract(a.attrs_json, '$.${attr}') AS REAL) >= CAST(? AS REAL)`;
        params.push(value);
      }
    } else if (req.operator === 'eq') {
      if (attr === 'vent') {
        sql += ` AND ('|' || COALESCE(a.vent, '') || '|') LIKE ?`;
        params.push(`%|${value}|%`);
      } else if (attr === 'cooking_top_technology') {
        sql += ` AND LOWER(COALESCE(a.cooking_top_technology, '')) LIKE ?`;
        params.push(`%${value}%`);
      } else if (METRIC_COLUMNS.has(attr)) {
        sql += ` AND CAST(a.${attr} AS TEXT) = ?`;
        params.push(value);
      } else {
        sql += ` AND LOWER(CAST(json_extract(a.attrs_json, '$.${attr}') AS TEXT)) = ?`;
        params.push(value);
      }
    }
  }
  return sql;
}

function buildAppliancePoolQuery(program, requirements, options = {}) {
  const brand = options.brand ? String(options.brand).trim().toLowerCase() : null;
  const categories = categoriesMatchingRebate(program.category);
  const catPlaceholders = categories.map(() => '?').join(', ');
  const params = [...categories];

  let sql = `
    SELECT a.model_id, a.category, a.brand
    FROM appliances a
    WHERE a.category IN (${catPlaceholders})
  `;

  if (options.seedOnly) {
    sql += ` AND a.model_id NOT LIKE 'es-%'`;
  } else if (options.esOnly) {
    sql += ` AND a.model_id LIKE 'es-%'`;
  }

  if (brand) {
    sql += ' AND LOWER(a.brand) = ?';
    params.push(brand);
  }

  if (program.category === 'induction_stove') {
    sql += `
      AND (
        a.category = 'induction_stove'
        OR LOWER(COALESCE(a.cooking_top_technology, '')) LIKE '%induction%'
      )
    `;
  }

  sql = appendRequirementFilters(sql, params, requirements);
  sql += `
    ORDER BY a.brand COLLATE NOCASE, a.model_id
    LIMIT ?
  `;
  params.push(options.limit);
  return { sql, params };
}

function getEnergyStarAppliancesForProgram(program, requirements, options = {}) {
  const limit = options.limit;
  if (limit <= 0) return [];

  const query = buildAppliancePoolQuery(program, requirements, {
    ...options,
    limit,
    esOnly: true
  });
  return db.prepare(query.sql).all(...query.params);
}

/**
 * Pull a bounded appliance pool that could satisfy a program's requirements.
 * Seed models are preferred; ENERGY STAR fills the remainder of the limit.
 */
function getAppliancesForProgram(program, requirements, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));

  const seedQuery = buildAppliancePoolQuery(program, requirements, {
    ...options,
    limit,
    seedOnly: true
  });
  const seed = db.prepare(seedQuery.sql).all(...seedQuery.params);
  if (seed.length >= limit) return seed;

  const remaining = limit - seed.length;
  const esRows = getEnergyStarAppliancesForProgram(program, requirements, {
    ...options,
    limit: remaining
  });
  return seed.concat(esRows);
}

function getAttributesForModels(modelIds, attributeNames = null) {
  if (!modelIds || modelIds.length === 0) return [];
  const placeholders = modelIds.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT model_id, attrs_json
     FROM appliances
     WHERE model_id IN (${placeholders})`
  ).all(...modelIds);

  const out = [];
  for (const row of rows) {
    out.push(...expandAttrsJson(row.model_id, row.attrs_json, attributeNames));
  }
  return out;
}

function getRetailListings(modelIds) {
  if (!modelIds || modelIds.length === 0) return [];
  try {
    const placeholders = modelIds.map(() => '?').join(', ');
    return db.prepare(
      `SELECT model_id, store, product_name, price, currency, url, model_number, fetched_at, match_score
       FROM retail_listings
       WHERE model_id IN (${placeholders})
       ORDER BY store`
    ).all(...modelIds);
  } catch (err) {
    if (String(err.message || '').includes('no such table')) return [];
    throw err;
  }
}

function buildDisplayName(appliance, attrsByName, retailRows) {
  const catalog = (retailRows || []).find(r => r.store === 'catalog' && r.product_name);
  if (catalog) return prettyLabel(catalog.product_name);

  const storeName = (retailRows || [])
    .filter(r => r.product_name && r.store !== 'catalog')
    .sort((a, b) => Number(b.match_score || 0) - Number(a.match_score || 0))[0];
  if (storeName && Number(storeName.match_score || 0) >= 5) {
    return prettyLabel(storeName.product_name);
  }

  const brand = prettyBrand(appliance.brand);
  const modelName = prettyLabel(attrsByName.model_name || '');
  if (modelName && brand && modelName.toLowerCase().includes(String(appliance.brand || '').toLowerCase())) {
    return modelName;
  }
  return [brand, modelName].filter(Boolean).join(' ').trim()
    || attrsByName.model_number
    || appliance.model_id;
}

function prettyBrand(value) {
  const raw = String(value || '').replace(/[_-]+/g, ' ').trim();
  const specials = {
    ge: 'GE',
    lg: 'LG',
    aosmith: 'A. O. Smith',
    'ao smith': 'A. O. Smith',
    rheem: 'Rheem',
    bosch: 'Bosch',
    carrier: 'Carrier',
    friedrich: 'Friedrich'
  };
  return specials[raw.toLowerCase()] || prettyLabel(raw);
}

function prettyLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => {
      const low = part.toLowerCase();
      if (['ge', 'lg', 'btu', 'uef', 'hp', 'ids'].includes(low)) return low.toUpperCase();
      if (low === 'a.' || low === 'o.') return low.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function getApplianceSummaries(modelIds) {
  if (!modelIds || modelIds.length === 0) return [];
  const placeholders = modelIds.map(() => '?').join(', ');
  const appliances = db.prepare(
    `SELECT model_id, category, brand, model_number, attrs_json
     FROM appliances
     WHERE model_id IN (${placeholders})`
  ).all(...modelIds);

  const highlightNames = [
    'model_number', 'model_name',
    'uef', 'seer2', 'efficiency', 'vent', 'storage_volume',
    'draw_pattern', 'fhr_rating', 'cooking_top_technology', 'imef', 'ceer'
  ];
  const retail = getRetailListings(modelIds);
  const retailByModel = new Map();
  for (const row of retail) {
    if (!retailByModel.has(row.model_id)) retailByModel.set(row.model_id, []);
    retailByModel.get(row.model_id).push(row);
  }

  const byModel = new Map(appliances.map(a => [a.model_id, {
    model_id: a.model_id,
    category: a.category,
    brand: a.brand,
    model_number: a.model_number || null,
    model_name: null,
    display_name: null,
    prices: [],
    highlights: {}
  }]));

  const highlightSet = new Set(highlightNames);
  const attrsByModel = new Map();

  for (const appliance of appliances) {
    const attrs = expandAttrsJson(appliance.model_id, appliance.attrs_json, highlightNames);
    const row = byModel.get(appliance.model_id);
    if (!row) continue;
    if (!attrsByModel.has(appliance.model_id)) attrsByModel.set(appliance.model_id, {});

    for (const attr of attrs) {
      attrsByModel.get(attr.model_id)[attr.attribute_name] = attr.attribute_value;
      if (attr.attribute_name === 'model_number') row.model_number = attr.attribute_value;
      if (attr.attribute_name === 'model_name') row.model_name = attr.attribute_value;
      if (highlightSet.has(attr.attribute_name)
          && attr.attribute_name !== 'model_number'
          && attr.attribute_name !== 'model_name') {
        if (!row.highlights[attr.attribute_name]) {
          row.highlights[attr.attribute_name] = attr.attribute_value;
        } else if (!String(row.highlights[attr.attribute_name]).split('|').includes(attr.attribute_value)) {
          row.highlights[attr.attribute_name] += `|${attr.attribute_value}`;
        }
      }
    }
  }

  for (const [modelId, row] of byModel.entries()) {
    const retailRows = retailByModel.get(modelId) || [];
    row.display_name = buildDisplayName(row, attrsByModel.get(modelId) || {}, retailRows);
    row.prices = retailRows
      .filter(r => r.store !== 'catalog' && r.price !== null && r.price !== undefined)
      .map(r => ({
        store: r.store,
        store_label: r.store === 'home_depot' ? 'Home Depot' : (r.store === 'lowes' ? "Lowe's" : r.store),
        product_name: r.product_name,
        price: Number(r.price),
        currency: r.currency || 'USD',
        fetched_at: r.fetched_at || null,
        url: r.url || null
      }));
  }

  return modelIds.map(id => byModel.get(id)).filter(Boolean);
}

/**
 * Bundle programs + bounded appliance pools for reverse Epilog evaluation.
 */
function getDiscoveryCandidates(zipCode, options = {}) {
  const programs = getProgramsForZip(zipCode, options.category || null);
  const requirements = getRequirementsForPrograms(programs.map(p => p.program_id));
  const reqsByProgram = new Map();
  for (const req of requirements) {
    if (!reqsByProgram.has(req.program_id)) reqsByProgram.set(req.program_id, []);
    reqsByProgram.get(req.program_id).push(req);
  }

  const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));
  const appliancesByProgram = {};
  const applianceMap = new Map();

  for (const program of programs) {
    const pool = getAppliancesForProgram(
      program,
      reqsByProgram.get(program.program_id) || [],
      { limit, brand: options.brand }
    );
    appliancesByProgram[program.program_id] = pool.map(a => a.model_id);
    for (const appliance of pool) {
      applianceMap.set(appliance.model_id, appliance);
    }
  }

  const appliances = [...applianceMap.values()];
  const neededAttrs = new Set([
    'model_number',
    'model_name',
    'energystar_id',
    'uef',
    'seer2',
    'efficiency',
    'vent',
    'storage_volume',
    'draw_pattern',
    'fhr_rating',
    'cooking_top_technology',
    'imef',
    'ceer'
  ]);
  for (const req of requirements) {
    neededAttrs.add(String(req.attribute_name).toLowerCase());
  }

  const attributes = getAttributesForModels(
    appliances.map(a => a.model_id),
    [...neededAttrs]
  );

  return {
    programs,
    requirements,
    appliances,
    attributes,
    appliancesByProgram,
    limit
  };
}

function categoryAliasesFor(category, attributes = []) {
  const cat = String(category).toLowerCase();
  const aliases = new Set([cat]);

  if (cat.includes('heat_pump') && !cat.includes('water')) {
    aliases.add('heat_pump');
  }
  if (cat.includes('water_heater')) {
    aliases.add('water_heater');
  }
  if (cat.includes('induction')) {
    aliases.add('induction_stove');
  }
  if (cat.includes('electric_cooking')) {
    aliases.add('electric_cooking');
    const isInduction = attributes.some(
      a => a.attribute_name === 'cooking_top_technology'
        && String(a.attribute_value).toLowerCase().includes('induction')
    );
    if (isInduction) aliases.add('induction_stove');
  }
  if (cat.includes('room_air_conditioner')) {
    aliases.add('room_air_conditioner');
  }
  if (cat.includes('clothes_washer')) {
    aliases.add('clothes_washer');
  }
  if (cat.includes('dishwasher')) {
    aliases.add('dishwasher');
  }
  if (cat.includes('refrigerator')) {
    aliases.add('refrigerator');
  }

  return [...aliases];
}

module.exports = {
  getCandidateFacts,
  findAppliance,
  getDiscoveryCandidates,
  getApplianceSummaries,
  getRetailListings,
  getRequirementsForPrograms
};
