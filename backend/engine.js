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
    sources: [],
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

function pushRebateFacts(facts, programs, requirements, matchedZip = null) {
  for (const r of programs || []) {
    // SQL already applied zip wildcards (e.g. 941*). Epilog needs an exact
    // zip atom, so bind the caller's matched ZIP when provided.
    facts.push([
      'rebate_program',
      atom(r.program_id),
      atom(matchedZip != null ? matchedZip : r.zip_code),
      atom(r.category),
      atom(r.income_cap),
      atom(r.amount)
    ]);
    if (r.income_cap === null || r.income_cap === undefined || r.income_cap === '') {
      facts.push(['rebate_no_income_cap', atom(r.program_id)]);
    }
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
  pushRebateFacts(facts, candidates.candidateRebates, candidates.requirements, zipCode);
  return facts;
}

function buildDiscoveryFacts(zipCode, income, discovery) {
  const facts = [['user_zip', atom(zipCode)]];
  if (income !== null && income !== undefined && income !== '' && Number.isFinite(Number(income))) {
    facts.push(['user_income', atom(income)]);
  }

  pushRebateFacts(facts, discovery.programs, discovery.requirements, zipCode);

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

  if (Number.isFinite(cap) && cap > 0 && !(incomeNum < cap)) {
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
    income_cap: Number.isFinite(cap) && cap > 0 ? cap : null,
    benefit_type: program.benefit_type || 'cash_rebate',
    benefit: parseJson(program.benefit_json),
    program_name: program.program_name || program.program_id,
    provider: program.provider || null,
    eligibility: parseJson(program.eligibility_json),
    valid_from: program.valid_from || null,
    valid_to: program.valid_to || null,
    source_url: program.source_url || null,
    verified_at: program.verified_at || null,
    status,
    reasons,
    missingAttributes: [...new Set(missingAttributes)]
  };
}

function parseJson(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function evaluateCondition(condition, context) {
  const key = String(condition.field || '').toLowerCase();
  const actual = context[key];
  const op = String(condition.operator || 'eq').toLowerCase();
  if (actual === undefined || actual === null || actual === '') return 'missing';
  const expected = condition.value;
  const aNum = Number(actual);
  const eNum = Number(expected);
  const dateCompare = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(expected))) return null;
    const left = Date.parse(actual);
    const right = Date.parse(expected);
    return Number.isFinite(left) && Number.isFinite(right) ? [left, right] : null;
  };
  switch (op) {
    case 'eq': return String(actual).toLowerCase() === String(expected).toLowerCase() ? 'pass' : 'fail';
    case 'neq': return String(actual).toLowerCase() !== String(expected).toLowerCase() ? 'pass' : 'fail';
    case 'in': return (Array.isArray(expected) ? expected : [expected]).some(v => String(v).toLowerCase() === String(actual).toLowerCase()) ? 'pass' : 'fail';
    case 'not_in': return (Array.isArray(expected) ? expected : [expected]).some(v => String(v).toLowerCase() === String(actual).toLowerCase()) ? 'fail' : 'pass';
    case 'gte': { const d = dateCompare(); return d ? (d[0] >= d[1] ? 'pass' : 'fail') : Number.isFinite(aNum) && Number.isFinite(eNum) ? (aNum >= eNum ? 'pass' : 'fail') : 'fail'; }
    case 'gt': { const d = dateCompare(); return d ? (d[0] > d[1] ? 'pass' : 'fail') : Number.isFinite(aNum) && Number.isFinite(eNum) ? (aNum > eNum ? 'pass' : 'fail') : 'fail'; }
    case 'lte': { const d = dateCompare(); return d ? (d[0] <= d[1] ? 'pass' : 'fail') : Number.isFinite(aNum) && Number.isFinite(eNum) ? (aNum <= eNum ? 'pass' : 'fail') : 'fail'; }
    case 'lt': { const d = dateCompare(); return d ? (d[0] < d[1] ? 'pass' : 'fail') : Number.isFinite(aNum) && Number.isFinite(eNum) ? (aNum < eNum ? 'pass' : 'fail') : 'fail'; }
    case 'between': return Number.isFinite(aNum) && Array.isArray(expected) && aNum >= Number(expected[0]) && aNum <= Number(expected[1]) ? 'pass' : 'fail';
    case 'exists': return actual !== undefined && actual !== null && actual !== '' ? 'pass' : 'missing';
    case 'contains': return String(actual).toLowerCase().includes(String(expected).toLowerCase()) ? 'pass' : 'fail';
    default: return 'unsupported';
  }
}

function assessProgram(program, income, answers = {}) {
  const benefit = parseJson(program.benefit_json);
  const conditions = parseJson(program.eligibility_json);
  const answersByKey = Object.fromEntries(Object.entries(answers || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  const context = { ...answersByKey };
  if (context.zip === undefined && context.zip_code !== undefined) context.zip = context.zip_code;
  if (income !== null && income !== undefined && income !== '' && Number.isFinite(Number(income))) {
    context.income = Number(income);
  }
  if (program.income_cap !== null && program.income_cap !== undefined && Number(program.income_cap) > 0) {
    if (income !== null && income !== undefined && income !== '' && Number.isFinite(Number(income))) {
      context.income = Number(income);
    }
  }
  const entries = [
    ...(Array.isArray(conditions.all) ? conditions.all : []),
    ...(Array.isArray(conditions.any) ? conditions.any : [])
  ];
  const missing = [];
  const failed = [];
  for (const condition of entries) {
    const result = evaluateCondition(condition, context);
    const label = condition.question || condition.label || condition.field || 'eligibility detail';
    if (result === 'missing') missing.push({
      field: String(condition.field || '').toLowerCase(),
      question: label,
      type: condition.type || 'text',
      options: Array.isArray(condition.options) ? condition.options : []
    });
    else if (result === 'fail') failed.push(label);
    else if (result === 'unsupported') failed.push(`Unsupported eligibility rule: ${condition.operator}`);
  }
  const all = Array.isArray(conditions.all) ? conditions.all : [];
  const any = Array.isArray(conditions.any) ? conditions.any : [];
  const cap = Number(program.income_cap);
  const hasIncomeCap = Number.isFinite(cap) && cap > 0;
  const incomeAvailable = context.income !== undefined && context.income !== null;
  const capFailed = hasIncomeCap && incomeAvailable && Number(context.income) >= cap;
  const capMissing = hasIncomeCap && !incomeAvailable;
  const allFailed = all.some(c => evaluateCondition(c, context) === 'fail');
  const anyPassed = any.length === 0 || any.some(c => evaluateCondition(c, context) === 'pass');
  const relevantMissing = [
    ...all.filter(c => evaluateCondition(c, context) === 'missing'),
    ...(any.length && !anyPassed ? any.filter(c => evaluateCondition(c, context) === 'missing') : []),
    ...(capMissing ? [{ field: 'income', question: 'What is your annual household income before taxes?', type: 'number' }] : [])
  ].map(c => ({
    field: String(c.field || '').toLowerCase(),
    question: c.question || c.label || c.field || 'eligibility detail',
    type: c.type || 'text',
    options: Array.isArray(c.options) ? c.options : []
  }));
  const relevantFailed = [
    ...all.filter(c => evaluateCondition(c, context) === 'fail'),
    ...(any.length && !anyPassed ? any.filter(c => evaluateCondition(c, context) === 'fail') : [])
  ].map(c => c.question || c.label || c.field || 'eligibility detail');
  const today = new Date().toISOString().slice(0, 10);
  const notStarted = Boolean(program.valid_from && today < program.valid_from);
  const expired = Boolean(program.valid_to && today > program.valid_to);
  const status = allFailed || !anyPassed || capFailed || notStarted || expired
    ? 'ineligible'
    : relevantMissing.length ? 'needs_input' : 'eligible';
  return {
    status,
    missing: [...new Map(relevantMissing.map(item => [item.field, item])).values()],
    failed: [...new Set([
      ...relevantFailed,
      ...(capFailed ? [`Income must be below $${cap}`] : []),
      ...(notStarted ? [`Program starts ${program.valid_from}`] : []),
      ...(expired ? [`Program ended ${program.valid_to}`] : [])
    ])],
    benefit,
    benefit_type: program.benefit_type || 'cash_rebate',
    program_name: program.program_name || program.program_id,
    provider: program.provider || null,
    valid_from: program.valid_from || null,
    valid_to: program.valid_to || null
  };
}

/**
 * Forward mode: one appliance → which rebates apply.
 */
function evaluateRebates(zipCode, income, modelId, overrides = {}, answers = {}) {
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

    const assessment = assessProgram(program, income, { ...answers, zip: zipCode, zip_code: zipCode });
    if (matchSet.has(atom(program.program_id)) && assessment.status === 'eligible') {
      return {
        ...explained,
        ...assessment,
        amount: program.amount === null ? null : Number(program.amount),
        income_cap: program.income_cap === null ? null : Number(program.income_cap),
        source_url: program.source_url || null,
        verified_at: program.verified_at || null,
        status: 'eligible',
        reasons: [],
        missingAttributes: []
      };
    }
    return {
      ...explained,
      ...assessment,
      amount: program.amount === null ? null : Number(program.amount),
      income_cap: program.income_cap === null ? null : Number(program.income_cap),
      source_url: program.source_url || null,
      verified_at: program.verified_at || null,
      status: assessment.status !== 'eligible' ? assessment.status : explained.status,
      reasons: [...(explained.reasons || []), ...(assessment.failed || []), ...(assessment.missing || []).map(q => `Need to confirm: ${q.question}`)],
      questions: assessment.missing
    };
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
    programQuestions: [...new Map(evaluations.flatMap(e => e.questions || []).map(q => [q.field, q])).values()],
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

function requirementMeta(req) {
  let label = null;
  try {
    const meta = JSON.parse(req.condition_json || '{}');
    label = meta.label || null;
  } catch {
    label = null;
  }
  return {
    attribute_name: req.attribute_name,
    operator: req.operator,
    attribute_value: req.attribute_value,
    label
  };
}

/** Human-readable equipment rules shown even when some filters are category-only. */
function equipmentRulesForProgram(program, requirements = []) {
  const labeled = requirements.map(requirementMeta);
  const fromAttrs = labeled.map(r => r.label || `${r.attribute_name} ${r.operator} ${r.attribute_value}`);
  const category = String(program.category || '').toLowerCase();
  const defaults = {
    water_heater: [
      'New ENERGY STAR heat pump water heater',
      'Electric-only (dual-fuel units are not eligible)'
    ],
    heat_pump: [
      'New ENERGY STAR air-source heat pump',
      'Electric-only (dual-fuel units are not eligible)'
    ],
    induction_stove: [
      'Permanently installed induction or ENERGY STAR electric cooking product',
      'Dual-fuel cooking products are not eligible'
    ],
    clothes_dryer: [
      'New ENERGY STAR electric clothes dryer',
      'Gas dryers are not eligible'
    ]
  };
  const base = defaults[category] || [`ENERGY STAR certified ${category || 'appliance'}`];
  return [...new Set([...base, ...fromAttrs])];
}

function effectiveIncomeValue(income, answers = {}) {
  if (income === null || income === undefined || income === '') {
    return answers.income ?? null;
  }
  return income;
}

function summarizeProgramCard(program, zipCode, effectiveIncome, answers, reqsByProgram, eligibleProgramIds) {
  const programId = atom(program.program_id);
  const assessment = assessProgram(program, effectiveIncome, { ...(answers || {}), zip: zipCode, zip_code: zipCode });
  const incomeEligible = eligibleProgramIds.has(programId) && assessment.status === 'eligible';
  const requirements = (reqsByProgram.get(programId) || []).map(requirementMeta);

  return {
    program_id: program.program_id,
    category: program.category,
    amount: program.amount === null ? null : Number(program.amount),
    income_cap: program.income_cap === null ? null : Number(program.income_cap),
    benefit_type: assessment.benefit_type,
    benefit: assessment.benefit,
    program_name: assessment.program_name,
    provider: assessment.provider,
    valid_from: assessment.valid_from,
    valid_to: assessment.valid_to,
    source_url: program.source_url || null,
    verified_at: program.verified_at || null,
    status: incomeEligible ? 'eligible' : assessment.status,
    reasons: [
      ...assessment.missing.map(question => `Need to confirm: ${question.question}`),
      ...assessment.failed.map(reason => `Does not meet: ${reason}`),
      ...(!eligibleProgramIds.has(programId) && assessment.status === 'eligible'
        ? [`Income $${Number(effectiveIncome)} is not below the program cap of $${Number(program.income_cap)}`]
        : [])
    ],
    requirements,
    equipment_rules: equipmentRulesForProgram(program, reqsByProgram.get(programId) || []),
    questions: assessment.missing
  };
}

function incomeEligibleProgramIds(zipCode, effectiveIncome, programs) {
  const programFacts = [['user_zip', atom(zipCode)]];
  if (effectiveIncome !== null && effectiveIncome !== undefined && effectiveIncome !== '' && Number.isFinite(Number(effectiveIncome))) {
    programFacts.push(['user_income', atom(effectiveIncome)]);
  }
  pushRebateFacts(programFacts, programs, [], zipCode);
  indexfacts(programFacts);

  const programMatches = compfinds(
    ['ProgramID', 'Category', 'Amount', 'IncomeCap'],
    ['eligible_program', 'ProgramID', 'Category', 'Amount', 'IncomeCap'],
    programFacts,
    eligibilityRules
  );
  return new Set(
    (Array.isArray(programMatches) ? programMatches : []).map(m => atom(m[0]))
  );
}

/**
 * Reverse mode step 1: ZIP (+ optional income/filters) → rebate program list.
 * Appliances are loaded separately when the user opens a program.
 */
function discoverEligible(zipCode, income, options = {}) {
  const effectiveIncome = effectiveIncomeValue(income, options.answers || {});
  const discovery = getDiscoveryCandidates(zipCode, {
    category: options.category || null,
    brand: options.brand || null,
    limit: options.limit || 25,
    includeAppliances: false
  });

  const reqsByProgram = new Map();
  for (const req of discovery.requirements || []) {
    const id = atom(req.program_id);
    if (!reqsByProgram.has(id)) reqsByProgram.set(id, []);
    reqsByProgram.get(id).push(req);
  }

  const eligibleProgramIds = incomeEligibleProgramIds(zipCode, effectiveIncome, discovery.programs);

  const programs = discovery.programs.map(program => ({
    ...summarizeProgramCard(
      program,
      zipCode,
      effectiveIncome,
      options.answers || {},
      reqsByProgram,
      eligibleProgramIds
    ),
    appliances: [],
    appliance_count: 0,
    candidate_pool_size: 0,
    more_appliances_available: false
  }));

  return {
    mode: 'discover',
    zip_code: String(zipCode),
    income: effectiveIncome === null ? null : Number(effectiveIncome),
    filters: {
      category: options.category || null,
      brand: options.brand || null,
      limit: discovery.limit
    },
    programs,
    eligible_program_count: programs.filter(p => p.status === 'eligible').length,
    needs_input_program_count: programs.filter(p => p.status === 'needs_input').length,
    eligible_appliance_count: 0
  };
}

/**
 * Reverse mode step 2: open one rebate → sample appliances that meet its equipment rules.
 */
function discoverEligibleAppliances(zipCode, income, programId, options = {}) {
  const effectiveIncome = effectiveIncomeValue(income, options.answers || {});
  const discovery = getDiscoveryCandidates(zipCode, {
    programId,
    brand: options.brand || null,
    limit: options.limit || 25,
    includeAppliances: true
  });

  if (!discovery.programs.length) {
    return {
      mode: 'discover_appliances',
      zip_code: String(zipCode),
      income: effectiveIncome === null ? null : Number(effectiveIncome),
      program: null,
      appliances: [],
      appliance_count: 0,
      more_appliances_available: false,
      error: `No program found for ${programId} in ZIP ${zipCode}`
    };
  }

  const program = discovery.programs[0];
  const requirements = discovery.requirements || [];
  const reqsByProgram = new Map([[atom(program.program_id), requirements]]);
  const eligibleProgramIds = incomeEligibleProgramIds(zipCode, effectiveIncome, [program]);
  const card = summarizeProgramCard(
    program,
    zipCode,
    effectiveIncome,
    options.answers || {},
    reqsByProgram,
    eligibleProgramIds
  );

  const matched = discoverProgramAppliances(
    zipCode,
    effectiveIncome,
    program,
    requirements,
    discovery
  );
  const summaries = getApplianceSummaries(matched.map(row => row.model_id));
  const summaryById = new Map(summaries.map(s => [atom(s.model_id), s]));
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
    mode: 'discover_appliances',
    zip_code: String(zipCode),
    income: effectiveIncome === null ? null : Number(effectiveIncome),
    filters: {
      brand: options.brand || null,
      limit: discovery.limit
    },
    program: {
      ...card,
      candidate_pool_size: poolSize,
      more_appliances_available: poolSize >= discovery.limit
    },
    appliances,
    appliance_count: appliances.length,
    more_appliances_available: poolSize >= discovery.limit
  };
}

module.exports = {
  evaluateRebates,
  discoverEligible,
  discoverEligibleAppliances,
  mergeAttributes
};
