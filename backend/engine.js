const fs = require('fs');
const path = require('path');
const { getCandidateFacts } = require('./db');
const { eligibilityRules } = require('../logic/rules/eligibility');

// Load Stanford EpilogJS engine into global context
const epilogCode = fs.readFileSync(path.join(__dirname, 'lib/epilog.js'), 'utf8');
eval(epilogCode);

function evaluateRebates(zipCode, income, modelId) {
  const candidates = getCandidateFacts(modelId, zipCode);
  if (!candidates) return [];

  // Lowercase modelId so Epilog treats it as a constant ('ahri-101') rather than a variable ('AHRI-101').
  // Epilog atoms must be strings: symbolp() is typeof === 'string', and a JS number is
  // treated as a compound term, so it never unifies with a variable or survives pluug.
  const safeModelId = String(modelId).toLowerCase();
  const atom = (value) => String(value);

  // 1. Construct facts natively as JS arrays
  const facts = [
    ['user_zip', atom(zipCode)],
    ['user_income', atom(income)],
    [
      'appliance_spec',
      safeModelId,
      candidates.appliance.category.toLowerCase(),
      atom(candidates.appliance.efficiency_rating)
    ]
  ];

  candidates.candidateRebates.forEach(r => {
    facts.push([
      'rebate_program',
      r.program_id.toLowerCase(),
      atom(r.zip_code),
      r.category.toLowerCase(),
      atom(r.min_efficiency),
      atom(r.income_cap),
      atom(r.amount)
    ]);
  });

  // Indexing is on by default. compfinds looks facts and rules up by those indexes,
  // so an unindexed theory matches nothing.
  indexfacts(facts);
  indexrules(eligibilityRules);

  // 2. Query target and expression as native JS arrays
  const queryExpr = ['eligible_rebate', safeModelId, 'ProgramID', 'Amount'];
  const targetExpr = ['ProgramID', 'Amount'];

  // 3. Perform deduction using Epilog's compfinds
  const results = compfinds(targetExpr, queryExpr, facts, eligibilityRules);

  if (!Array.isArray(results)) return [];

  return results.map(match => ({
    program_id: Array.isArray(match) ? match[0] : match,
    amount: Array.isArray(match) ? Number(match[1]) : 0
  }));
}

module.exports = { evaluateRebates };