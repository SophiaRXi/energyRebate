const fs = require('fs');
const path = require('path');
const { getCandidateFacts } = require('./db');
const { eligibilityRules } = require('../logic/rules/eligibility');

const epilogCode = fs.readFileSync(path.join(__dirname, 'lib/epilog.js'), 'utf8');
eval(epilogCode);

// Index rules once. Re-indexing the same array on every request would duplicate entries.
indexrules(eligibilityRules);

function atom(value) {
  return String(value).toLowerCase();
}

function normalizeAttributeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_]/g, '');
}

/**
 * Merge DB attributes with request-scoped overrides.
 * Overrides are session-only: they are never written to SQLite.
 * Override values replace all DB values for that attribute name.
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

function buildFacts(candidates, zipCode, income, modelId, attributes) {
  const safeModelId = atom(modelId);
  const category = atom(candidates.appliance.category);

  const facts = [
    ['user_zip', atom(zipCode)],
    ['user_income', atom(income)],
    ['appliance', safeModelId],
    ['appliance_type', safeModelId, category]
  ];

  for (const attr of attributes) {
    facts.push(['appliance_attr', safeModelId, attr.attribute_name, attr.attribute_value]);
  }

  for (const r of candidates.candidateRebates) {
    const programId = atom(r.program_id);
    facts.push([
      'rebate_program',
      programId,
      atom(r.zip_code),
      atom(r.category),
      atom(r.income_cap),
      atom(r.amount)
    ]);
  }

  for (const req of candidates.requirements || []) {
    const programId = atom(req.program_id);
    const attr = normalizeAttributeName(req.attribute_name);
    const value = atom(req.attribute_value);
    if (req.operator === 'gte') {
      facts.push(['rebate_req_gte', programId, attr, value]);
    } else if (req.operator === 'eq') {
      facts.push(['rebate_req_eq', programId, attr, value]);
    }
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
 * Evaluate rebate eligibility.
 * @param {string} zipCode
 * @param {number|string} income
 * @param {string} modelId
 * @param {object} [overrides] session-only attribute answers, e.g. { vent: 'power' }
 */
function evaluateRebates(zipCode, income, modelId, overrides = {}) {
  const candidates = getCandidateFacts(modelId, zipCode);
  if (!candidates) {
    return {
      found: false,
      matches: [],
      evaluations: [],
      attributesUsed: [],
      missingAttributes: [],
      appliance: null
    };
  }

  const attributes = mergeAttributes(candidates.attributes, overrides);
  const facts = buildFacts(candidates, zipCode, income, modelId, attributes);
  const safeModelId = atom(modelId);

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

    // Prefer Epilog's positive match when explanations say eligible.
    if (matchSet.has(atom(program.program_id)) && explained.status === 'eligible') {
      return explained;
    }
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
    found: true,
    matches,
    evaluations,
    attributesUsed: attributes,
    missingAttributes,
    overridesApplied: Object.keys(overrides || {}).filter(
      k => overrides[k] !== undefined && overrides[k] !== null && overrides[k] !== ''
    ),
    appliance: {
      model_id: candidates.appliance.model_id,
      category: candidates.appliance.category,
      brand: candidates.appliance.brand
    }
  };
}

module.exports = { evaluateRebates, mergeAttributes };
