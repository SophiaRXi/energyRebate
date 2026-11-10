const fs = require('fs');
const path = require('path');
const {
  getCandidateFacts,
  getDiscoveryCandidates,
  getApplianceSummaries
} = require('./db');

function summarizeAppliance(modelId, fallback = {}) {
  const [summary] = getApplianceSummaries([modelId]);
  if (summary) return summary;
  return {
    model_id: fallback.model_id || modelId,
    category: fallback.category || null,
    brand: fallback.brand || null,
    model_number: null,
    model_name: null,
    display_name: fallback.brand ? `${fallback.brand} ${modelId}` : modelId,
    prices: [],
    highlights: {}
  };
}
const { eligibilityRules } = require('../logic/rules/eligibility');

const epilogCode = fs.readFileSync(path.join(__dirname, 'lib/epilog.js'), 'utf8');
eval(epilogCode);

// Index rules once. Re-indexing the same array on every request would duplicate entries.
indexrules(eligibilityRules);

function atom(value) {
  return String(value).toLowerCase();
}

function canonicalCategory(category) {
  const cat = String(category || '').toLowerCase();
  if (cat.includes('water_heater')) return 'water_heater';
  if (cat.includes('geothermal_heat_pump')) return 'geothermal_heat_pump';
  if (cat.includes('heat_pump')) return 'heat_pump';
  if (cat.includes('induction')) return 'induction_stove';
  if (cat.includes('electric_cooking')) return 'electric_cooking';
  if (cat.includes('room_air_conditioner')) return 'room_air_conditioner';
  if (cat.includes('clothes_washer')) return 'clothes_washer';
  if (cat.includes('dishwasher')) return 'dishwasher';
  if (cat.includes('refrigerator')) return 'refrigerator';
  return cat;
}

function normalizeAttributeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_]/g, '');
}

/**
 * Merge DB attributes with request-scoped overrides.
 * Overrides are session-only: they are never written to SQLite.
 */
function mergeAttributes(dbAttributes, overrides = {}) {
  const byName = new Map();

  for (const attr of dbAttributes || []) {
    const name = normalizeAttributeName(attr.attribute_name);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(atom(attr.attribute_value));
  }

  for (const [rawName, rawValue] of Object.entries(overrides || {})) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const name = normalizeAttributeName(rawName);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    byName.set(name, values.map(atom));
  }

  const merged = [];
  for (const [name, values] of byName.entries()) {
    for (const value of values) {
      merged.push({ attribute_name: name, attribute_value: value });
    }
  }
  return merged;
}

function pushRebateFacts(facts, programs, requirements) {
  for (const r of programs || []) {
    facts.push([
      'rebate_program',
      atom(r.program_id),
      atom(r.zip_code),
      atom(r.category),
      atom(r.income_cap),
      atom(r.amount)
    ]);
  }

  for (const req of requirements || []) {
    const programId = atom(req.program_id);
    const attr = normalizeAttributeName(req.attribute_name);
    const value = atom(req.attribute_value);
    if (req.operator === 'gte') {
      facts.push(['rebate_req_gte', programId, attr, value]);
    } else if (req.operator === 'eq') {
      facts.push(['rebate_req_eq', programId, attr, value]);
    }
  }
}

function pushApplianceFacts(facts, appliance, attributes, rebateCategories = []) {
  const safeModelId = atom(appliance.model_id);
  const category = canonicalCategory(appliance.category);

  facts.push(['appliance', safeModelId]);
  facts.push(['appliance_type', safeModelId, category]);

  for (const rebateCategory of rebateCategories) {
    if (atom(rebateCategory) !== category) {
      facts.push(['appliance_type', safeModelId, atom(rebateCategory)]);
    }
  }

  for (const attr of attributes || []) {
    facts.push([
      'appliance_attr',
      safeModelId,
      normalizeAttributeName(attr.attribute_name),
      atom(attr.attribute_value)
    ]);
  }
}

function buildForwardFacts(candidates, zipCode, income, modelId, attributes) {
  const facts = [
    ['user_zip', atom(zipCode)],
    ['user_income', atom(income)]
  ];

  const rebateCategories = (candidates.candidateRebates || []).map(r => r.category);
  pushApplianceFacts(
    facts,
    { model_id: candidates.appliance.model_id || modelId, category: candidates.appliance.category },
    attributes,
    rebateCategories
  );
  pushRebateFacts(facts, candidates.candidateRebates, candidates.requirements);
  return facts;
}

function buildDiscoveryFacts(zipCode, income, discovery) {
  const facts = [
    ['user_zip', atom(zipCode)],
    ['user_income', atom(income)]
  ];

  pushRebateFacts(facts, discovery.programs, discovery.requirements);

  const attrsByModel = new Map();
  for (const attr of discovery.attributes || []) {
    if (!attrsByModel.has(attr.model_id)) attrsByModel.set(attr.model_id, []);
    attrsByModel.get(attr.model_id).push(attr);
  }

  const programCategories = [...new Set((discovery.programs || []).map(p => p.category))];
  for (const appliance of discovery.appliances || []) {
    pushApplianceFacts(
      facts,
      appliance,
      attrsByModel.get(appliance.model_id) || [],
      programCategories
    );
  }

  return facts;
}

function explainProgram(program, income, attributes, requirements) {
  const reasons = [];
  const missingAttributes = [];
  const incomeNum = Number(income);
  const cap = Number(program.income_cap);

  if (!(incomeNum < cap)) {
    reasons.push(`Income $${incomeNum} is not below the program cap of $${cap}`);
  }

  const attrs = attributes || [];
  const hasAttr = (name) => attrs.some(a => a.attribute_name === name);
  const valuesOf = (name) => attrs.filter(a => a.attribute_name === name).map(a => a.attribute_value);

  for (const req of requirements) {
    const name = normalizeAttributeName(req.attribute_name);
    const required = atom(req.attribute_value);

    if (!hasAttr(name)) {
      missingAttributes.push(name);
      continue;
    }

    const values = valuesOf(name);
    if (req.operator === 'gte') {
      const ok = values.some(v => !(Number(v) < Number(required)));
      if (!ok) {
        reasons.push(
          `${name} is ${values.join(', ')}, but this program requires ${name} >= ${required}`
        );
      }
    } else if (req.operator === 'eq') {
      if (!values.includes(required)) {
        reasons.push(
          `${name} is ${values.join(', ')}, but this program requires ${name} = ${required}`
        );
      }
    }
  }

  let status = 'eligible';
  if (missingAttributes.length > 0) status = 'needs_input';
  else if (reasons.length > 0) status = 'ineligible';

  return {
    program_id: program.program_id,
    amount: Number(program.amount),
    income_cap: cap,
    status,
    reasons,
    missingAttributes: [...new Set(missingAttributes)]
  };
}

/**
 * Forward mode: one appliance → which rebates apply.
 */
function evaluateRebates(zipCode, income, modelId, overrides = {}) {
  const candidates = getCandidateFacts(modelId, zipCode);
  if (!candidates) {
    return {
      mode: 'appliance',
      found: false,
      matches: [],
      evaluations: [],
      attributesUsed: [],
      missingAttributes: [],
      appliance: null
    };
  }

  const attributes = mergeAttributes(candidates.attributes, overrides);
  const facts = buildForwardFacts(candidates, zipCode, income, modelId, attributes);
  const safeModelId = atom(candidates.appliance.model_id || modelId);

  indexfacts(facts);

  const epilogMatches = compfinds(
    ['ProgramID', 'Amount'],
    ['eligible_rebate', safeModelId, 'ProgramID', 'Amount'],
    facts,
    eligibilityRules
  );

  const matchSet = new Set(
    (Array.isArray(epilogMatches) ? epilogMatches : []).map(m =>
      Array.isArray(m) ? atom(m[0]) : atom(m)
    )
  );

  const reqsByProgram = new Map();
  for (const req of candidates.requirements || []) {
    const id = atom(req.program_id);
    if (!reqsByProgram.has(id)) reqsByProgram.set(id, []);
    reqsByProgram.get(id).push(req);
  }

  const evaluations = candidates.candidateRebates.map(program => {
    const explained = explainProgram(
      program,
      income,
      attributes,
      reqsByProgram.get(atom(program.program_id)) || []
    );

    if (matchSet.has(atom(program.program_id))) {
      return { ...explained, status: 'eligible', reasons: [], missingAttributes: [] };
    }
    return explained;
  });

  const matches = evaluations
    .filter(e => e.status === 'eligible')
    .map(e => ({ program_id: e.program_id, amount: e.amount }));

  const missingAttributes = [...new Set(
    evaluations.flatMap(e => e.missingAttributes || [])
  )];

  return {
    mode: 'appliance',
    found: true,
    matches,
    evaluations,
    attributesUsed: attributes,
    missingAttributes,
    overridesApplied: Object.keys(overrides || {}).filter(
      k => overrides[k] !== undefined && overrides[k] !== null && overrides[k] !== ''
    ),
    appliance: summarizeAppliance(candidates.appliance.model_id, candidates.appliance)
  };
}

function discoverProgramAppliances(zipCode, income, program, requirements, discovery) {
  const programModelIds = discovery.appliancesByProgram[program.program_id] || [];
  const appliances = discovery.appliances.filter(a => programModelIds.includes(a.model_id));
  const modelSet = new Set(appliances.map(a => a.model_id));
  const attributes = (discovery.attributes || []).filter(a => modelSet.has(a.model_id));

  const facts = buildDiscoveryFacts(zipCode, income, {
    programs: [program],
    requirements,
    appliances,
    attributes
  });
  indexfacts(facts);

  // Same eligible_rebate rule as forward mode, with ModelID unbound and ProgramID bound.
  const matches = compfinds(
    ['ModelID', 'Amount'],
    ['eligible_rebate', 'ModelID', atom(program.program_id), 'Amount'],
    facts,
    eligibilityRules
  );

  return (Array.isArray(matches) ? matches : []).map(match => ({
    model_id: atom(match[0]),
    amount: Number(match[1])
  }));
}

/**
 * Reverse mode: zip + income → eligible programs and buyable appliances.
 * Uses the same eligible_rebate rule with ModelID left unbound, queried per program
 * so Epilog stays fast against the large ENERGY STAR catalog.
 */
function discoverEligible(zipCode, income, options = {}) {
  const discovery = getDiscoveryCandidates(zipCode, {
    category: options.category || null,
    brand: options.brand || null,
    limit: options.limit || 25
  });

  const reqsByProgram = new Map();
  for (const req of discovery.requirements || []) {
    const id = atom(req.program_id);
    if (!reqsByProgram.has(id)) reqsByProgram.set(id, []);
    reqsByProgram.get(id).push(req);
  }

  // Income/ZIP program eligibility with a tiny fact set (no appliances).
  const programFacts = [
    ['user_zip', atom(zipCode)],
    ['user_income', atom(income)]
  ];
  pushRebateFacts(programFacts, discovery.programs, []);
  indexfacts(programFacts);

  const programMatches = compfinds(
    ['ProgramID', 'Category', 'Amount', 'IncomeCap'],
    ['eligible_program', 'ProgramID', 'Category', 'Amount', 'IncomeCap'],
    programFacts,
    eligibilityRules
  );
  const eligibleProgramIds = new Set(
    (Array.isArray(programMatches) ? programMatches : []).map(m => atom(m[0]))
  );

  const matchedByProgram = new Map();
  for (const program of discovery.programs) {
    const programId = atom(program.program_id);
    if (!eligibleProgramIds.has(programId)) {
      matchedByProgram.set(programId, []);
      continue;
    }
    matchedByProgram.set(
      programId,
      discoverProgramAppliances(
        zipCode,
        income,
        program,
        reqsByProgram.get(programId) || [],
        discovery
      )
    );
  }

  const allModelIds = [...new Set(
    [...matchedByProgram.values()].flatMap(rows => rows.map(r => r.model_id))
  )];
  const summaries = getApplianceSummaries(allModelIds);
  const summaryById = new Map(summaries.map(s => [atom(s.model_id), s]));

  const programs = discovery.programs.map(program => {
    const programId = atom(program.program_id);
    const incomeEligible = eligibleProgramIds.has(programId);
    const matched = matchedByProgram.get(programId) || [];
    const appliances = matched.map(row => {
      const summary = summaryById.get(row.model_id) || {
        model_id: row.model_id,
        brand: null,
        category: program.category,
        model_number: null,
        model_name: null,
        highlights: {}
      };
      return {
        ...summary,
        rebate_amount: row.amount
      };
    });

    const poolSize = (discovery.appliancesByProgram[program.program_id] || []).length;

    return {
      program_id: program.program_id,
      category: program.category,
      amount: Number(program.amount),
      income_cap: Number(program.income_cap),
      status: incomeEligible ? 'eligible' : 'ineligible',
      reasons: incomeEligible
        ? []
        : [`Income $${Number(income)} is not below the program cap of $${Number(program.income_cap)}`],
      requirements: (reqsByProgram.get(programId) || []).map(r => ({
        attribute_name: r.attribute_name,
        operator: r.operator,
        attribute_value: r.attribute_value
      })),
      appliances,
      appliance_count: appliances.length,
      candidate_pool_size: poolSize,
      more_appliances_available: poolSize >= discovery.limit
    };
  });

  return {
    mode: 'discover',
    zip_code: String(zipCode),
    income: Number(income),
    filters: {
      category: options.category || null,
      brand: options.brand || null,
      limit: discovery.limit
    },
    programs,
    eligible_program_count: programs.filter(p => p.status === 'eligible').length,
    eligible_appliance_count: allModelIds.length
  };
}

module.exports = { evaluateRebates, discoverEligible, mergeAttributes };
