const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/rebates.db'));

function findAppliance(modelId) {
  const key = String(modelId).trim();
  if (!key) return null;

  let appliance = db.prepare(
    `SELECT model_id, category, brand
     FROM appliances
     WHERE LOWER(model_id) = LOWER(?)`
  ).get(key);

  if (appliance) return appliance;

  // ENERGY STAR imports store the public model number as an attribute while
  // using es-<unique_id> as the primary key.
  const byModelNumber = db.prepare(
    `SELECT a.model_id, a.category, a.brand
     FROM appliance_attributes attr
     JOIN appliances a ON a.model_id = attr.model_id
     WHERE attr.attribute_name = 'model_number'
       AND LOWER(attr.attribute_value) = LOWER(?)
     LIMIT 1`
  ).get(key);

  if (byModelNumber) return byModelNumber;

  const byEnergyStarId = db.prepare(
    `SELECT a.model_id, a.category, a.brand
     FROM appliance_attributes attr
     JOIN appliances a ON a.model_id = attr.model_id
     WHERE attr.attribute_name = 'energystar_id'
       AND LOWER(attr.attribute_value) = LOWER(?)
     LIMIT 1`
  ).get(key);

  return byEnergyStarId || null;
}

function getCandidateFacts(modelId, zipCode) {
  const appliance = findAppliance(modelId);
  if (!appliance) return null;

  const attributes = db.prepare(
    `SELECT attribute_name, attribute_value
     FROM appliance_attributes
     WHERE model_id = ?`
  ).all(appliance.model_id);

  const categoryAliases = categoryAliasesFor(appliance.category, attributes);
  const placeholders = categoryAliases.map(() => '?').join(', ');
  const candidateRebates = db.prepare(
    `SELECT program_id, zip_code, category, income_cap, amount
     FROM rebates
     WHERE CAST(zip_code AS TEXT) = ? AND category IN (${placeholders})`
  ).all(String(zipCode), ...categoryAliases);

  const requirements = getRequirementsForPrograms(candidateRebates.map(r => r.program_id));
  return { appliance, attributes, candidateRebates, requirements };
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

function buildAppliancePoolQuery(program, requirements, options = {}) {
  const brand = options.brand ? String(options.brand).trim().toLowerCase() : null;
  const categories = categoriesMatchingRebate(program.category);
  const catPlaceholders = categories.map(() => '?').join(', ');
  const params = [...categories];

  let sql = `
    SELECT DISTINCT a.model_id, a.category, a.brand
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
        OR EXISTS (
          SELECT 1 FROM appliance_attributes ind
          WHERE ind.model_id = a.model_id
            AND ind.attribute_name = 'cooking_top_technology'
            AND ind.attribute_value LIKE '%induction%'
        )
      )
    `;
  }

  for (const req of requirements || []) {
    const attr = String(req.attribute_name).toLowerCase();
    const value = String(req.attribute_value).toLowerCase();
    if (req.operator === 'gte') {
      sql += `
        AND EXISTS (
          SELECT 1 FROM appliance_attributes req_attr
          WHERE req_attr.model_id = a.model_id
            AND req_attr.attribute_name = ?
            AND CAST(req_attr.attribute_value AS REAL) >= CAST(? AS REAL)
        )
      `;
      params.push(attr, value);
    } else if (req.operator === 'eq') {
      sql += `
        AND EXISTS (
          SELECT 1 FROM appliance_attributes req_attr
          WHERE req_attr.model_id = a.model_id
            AND req_attr.attribute_name = ?
            AND req_attr.attribute_value = ?
        )
      `;
      params.push(attr, value);
    }
  }

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

  const categories = categoriesMatchingRebate(program.category);
  const brand = options.brand ? String(options.brand).trim().toLowerCase() : null;
  const gteReq = (requirements || []).find(r => r.operator === 'gte');
  const eqReqs = (requirements || []).filter(r => r.operator === 'eq');

  // Attribute-first query: starting from appliances over 300k rows with EXISTS
  // filters is too slow. Drive from the indexed attribute table instead.
  let sql;
  const params = [];

  if (gteReq) {
    sql = `
      SELECT a.model_id, a.category, a.brand
      FROM appliance_attributes pivot
      JOIN appliances a ON a.model_id = pivot.model_id
      WHERE pivot.attribute_name = ?
        AND CAST(pivot.attribute_value AS REAL) >= CAST(? AS REAL)
        AND a.model_id LIKE 'es-%'
        AND a.category IN (${categories.map(() => '?').join(', ')})
    `;
    params.push(
      String(gteReq.attribute_name).toLowerCase(),
      String(gteReq.attribute_value).toLowerCase(),
      ...categories
    );
  } else {
    sql = `
      SELECT a.model_id, a.category, a.brand
      FROM appliances a
      WHERE a.model_id LIKE 'es-%'
        AND a.category IN (${categories.map(() => '?').join(', ')})
    `;
    params.push(...categories);
  }

  if (brand) {
    sql += ' AND LOWER(a.brand) = ?';
    params.push(brand);
  }

  for (const req of eqReqs) {
    sql += `
      AND EXISTS (
        SELECT 1 FROM appliance_attributes eq_attr
        WHERE eq_attr.model_id = a.model_id
          AND eq_attr.attribute_name = ?
          AND eq_attr.attribute_value = ?
      )
    `;
    params.push(String(req.attribute_name).toLowerCase(), String(req.attribute_value).toLowerCase());
  }

  if (program.category === 'induction_stove') {
    sql += `
      AND (
        a.category = 'induction_stove'
        OR EXISTS (
          SELECT 1 FROM appliance_attributes ind
          WHERE ind.model_id = a.model_id
            AND ind.attribute_name = 'cooking_top_technology'
            AND ind.attribute_value LIKE '%induction%'
        )
      )
    `;
  }

  sql += ' ORDER BY a.brand COLLATE NOCASE, a.model_id LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
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
  if (attributeNames && attributeNames.length > 0) {
    const attrPlaceholders = attributeNames.map(() => '?').join(', ');
    return db.prepare(
      `SELECT model_id, attribute_name, attribute_value
       FROM appliance_attributes
       WHERE model_id IN (${placeholders})
         AND attribute_name IN (${attrPlaceholders})`
    ).all(...modelIds, ...attributeNames);
  }
  return db.prepare(
    `SELECT model_id, attribute_name, attribute_value
     FROM appliance_attributes
     WHERE model_id IN (${placeholders})`
  ).all(...modelIds);
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
    // Older DBs from before retail enrichment simply have no table yet.
    if (String(err.message || '').includes('no such table')) return [];
    throw err;
  }
}

function buildDisplayName(appliance, attrsByName, retailRows) {
  // Prefer curated/catalog title, then a high-confidence store title.
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
    `SELECT model_id, category, brand
     FROM appliances
     WHERE model_id IN (${placeholders})`
  ).all(...modelIds);

  const highlightNames = [
    'model_number', 'model_name',
    'uef', 'seer2', 'efficiency', 'vent', 'storage_volume',
    'draw_pattern', 'fhr_rating', 'cooking_top_technology', 'imef', 'ceer'
  ];
  const attrs = getAttributesForModels(modelIds, highlightNames);
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
    model_number: null,
    model_name: null,
    display_name: null,
    prices: [],
    highlights: {}
  }]));

  const highlightSet = new Set(highlightNames);
  const attrsByModel = new Map();

  for (const attr of attrs) {
    const row = byModel.get(attr.model_id);
    if (!row) continue;
    if (!attrsByModel.has(attr.model_id)) attrsByModel.set(attr.model_id, {});
    attrsByModel.get(attr.model_id)[attr.attribute_name] = attr.attribute_value;

    if (attr.attribute_name === 'model_number') row.model_number = attr.attribute_value;
    if (attr.attribute_name === 'model_name') row.model_name = attr.attribute_value;
    if (highlightSet.has(attr.attribute_name) && attr.attribute_name !== 'model_number' && attr.attribute_name !== 'model_name') {
      if (!row.highlights[attr.attribute_name]) {
        row.highlights[attr.attribute_name] = attr.attribute_value;
      } else if (!String(row.highlights[attr.attribute_name]).split('|').includes(attr.attribute_value)) {
        row.highlights[attr.attribute_name] += `|${attr.attribute_value}`;
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
