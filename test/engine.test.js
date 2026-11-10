const { evaluateRebates, discoverEligible } = require('../backend/engine');
const assert = require('assert');

console.log('Running Logic Engine Diagnostics...\n');

function assertEligible(result, programId, label) {
  assert(result.found, `${label}: appliance should be found`);
  assert(
    result.matches.some(m => m.program_id === programId),
    `${label}: expected eligible program ${programId}, got ${JSON.stringify(result.matches)}`
  );
}

function assertStatus(result, programId, status, label) {
  const evaluation = result.evaluations.find(e => e.program_id === programId);
  assert(evaluation, `${label}: missing evaluation for ${programId}`);
  assert.strictEqual(
    evaluation.status,
    status,
    `${label}: expected ${programId} status ${status}, got ${evaluation.status} (${JSON.stringify(evaluation)})`
  );
}

// 1. Basic Eligibility Test
const res1 = evaluateRebates('94102', 75000, 'AHRI-101');
assertEligible(res1, 'pg_94102_hp', 'Test 1');
console.log('✓ Test 1 Passed: Base rebate evaluation');

// 2. Income Cap Enforcement
const res2 = evaluateRebates('94102', 150000, 'AHRI-101');
assert.strictEqual(res2.matches.length, 0, 'Test 2 Failed: High income should return 0 matches');
assertStatus(res2, 'pg_94102_hp', 'ineligible', 'Test 2');
assert(
  res2.evaluations[0].reasons.some(r => /income/i.test(r)),
  'Test 2 Failed: Should explain income cap failure'
);
console.log('✓ Test 2 Passed: Income cap enforcement with reason');

// 3. Invalid ZIP Code Handling
const res3 = evaluateRebates('00000', 50000, 'AHRI-101');
assert.strictEqual(res3.matches.length, 0, 'Test 3 Failed: Invalid ZIP should return 0 matches');
assert.strictEqual(res3.evaluations.length, 0, 'Test 3 Failed: No local programs for invalid ZIP');
console.log('✓ Test 3 Passed: Invalid ZIP code handling');

// 4-5. Water heaters with different attribute sets
const res4 = evaluateRebates('94102', 75000, 'Rheem_XE40H06TT45U0');
assertEligible(res4, 'pg_94102_wh', 'Test 4');
assertStatus(res4, 'pg_94102_wh_powervent', 'needs_input', 'Test 4');
assert.deepStrictEqual(
  res4.evaluations.find(e => e.program_id === 'pg_94102_wh_powervent').missingAttributes,
  ['vent'],
  'Test 4 Failed: Power-vent program should ask for vent'
);

const res5 = evaluateRebates('94102', 75000, 'FRIEDRICH_PROP_G40-50_RH_HE_EC3');
assertEligible(res5, 'pg_94102_wh', 'Test 5');
assertEligible(res5, 'pg_94102_wh_powervent', 'Test 5');
console.log('✓ Tests 4-5 Passed: Optional attributes and power-vent requirement');

// 6. Session overrides are applied but not required from DB
const res6a = evaluateRebates('94102', 75000, 'UnknownVent_WH40');
assertStatus(res6a, 'pg_94102_wh_powervent', 'needs_input', 'Test 6a');
assert.ok(res6a.missingAttributes.includes('vent'), 'Test 6a Failed: vent should be missing');

const res6b = evaluateRebates('94102', 75000, 'UnknownVent_WH40', { vent: 'power' });
assertEligible(res6b, 'pg_94102_wh_powervent', 'Test 6b');
assert.ok(res6b.overridesApplied.includes('vent'), 'Test 6b Failed: override should be reported');

const res6c = evaluateRebates('94102', 75000, 'UnknownVent_WH40', { vent: 'atmospheric' });
assertStatus(res6c, 'pg_94102_wh_powervent', 'ineligible', 'Test 6c');
assert(
  res6c.evaluations.find(e => e.program_id === 'pg_94102_wh_powervent').reasons.some(r => /vent/i.test(r)),
  'Test 6c Failed: Should explain vent mismatch'
);
console.log('✓ Test 6 Passed: Session-only overrides for missing data');

// 7. Efficiency lives in attributes (not a required appliance column)
const res7 = evaluateRebates('94102', 75000, 'GE_GDE21DMKES');
assertEligible(res7, 'pg_94102_ind', 'Test 7');
assertStatus(res7, 'pg_94102_ind_premium', 'ineligible', 'Test 7');
assert(
  res7.evaluations.find(e => e.program_id === 'pg_94102_ind_premium').reasons.some(r => /efficiency/i.test(r)),
  'Test 7 Failed: Should explain efficiency shortfall'
);
console.log('✓ Test 7 Passed: Efficiency-as-attribute and failed threshold reason');

// 8. Reverse discovery: income-eligible programs + sample appliances via unbound ModelID
const res8 = discoverEligible('94102', 75000, { limit: 25 });
assert.strictEqual(res8.mode, 'discover', 'Test 8 Failed: mode should be discover');
assert(res8.eligible_program_count > 0, 'Test 8 Failed: expected income-eligible programs');
const whProgram = res8.programs.find(p => p.program_id === 'pg_94102_wh');
assert(whProgram && whProgram.status === 'eligible', 'Test 8 Failed: water heater program should be eligible');
assert(
  whProgram.appliances.some(a => a.model_id === 'rheem_xe40h06tt45u0' || a.brand === 'Rheem'),
  'Test 8 Failed: Rheem seed water heater should appear in reverse results'
);
const hpProgram = res8.programs.find(p => p.program_id === 'pg_94102_hp');
assert(
  hpProgram && hpProgram.appliances.some(a => a.model_id === 'ahri-101'),
  'Test 8 Failed: AHRI-101 should appear for heat pump program'
);
console.log('✓ Test 8 Passed: Reverse Epilog discovery of rebates and appliances');

// 9. Reverse discovery respects income caps and category filters
const res9 = discoverEligible('94102', 150000, { category: 'heat_pump' });
assert.strictEqual(res9.programs.length, 1, 'Test 9 Failed: category filter should keep one program');
assert.strictEqual(res9.programs[0].status, 'ineligible', 'Test 9 Failed: high income should block program');
assert.strictEqual(res9.programs[0].appliances.length, 0, 'Test 9 Failed: ineligible program should list no appliances');
console.log('✓ Test 9 Passed: Reverse discovery income + category filters');

console.log('\nAll Engine Tests Passed Successfully!\n');
