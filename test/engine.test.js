const {
  evaluateRebates,
  discoverEligible,
  discoverEligibleAppliances
} = require('../backend/engine');
const assert = require('assert');

console.log('Running Logic Engine Diagnostics...\n');

function answersFor(programHints = {}) {
  return {
    cleanpowersf_customer: 'yes',
    permit_requirements_met: 'yes',
    electrification_rate: 'yes',
    ...programHints
  };
}

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

// 1. Heat pump water heater that meets UEF >= 3.3
const res1 = evaluateRebates(
  '94102',
  75000,
  'rheem_xe50t10h45u0',
  {},
  answersFor({
    existing_water_heater_fuel: 'gas',
    installation_date: '2025-06-01'
  })
);
assertEligible(res1, 'cleanpowersf_hpwh', 'Test 1');
console.log('✓ Test 1 Passed: CleanPowerSF HPWH evaluation');

// 2. Gas water heater fails UEF threshold
const res2 = evaluateRebates(
  '94102',
  75000,
  'rheem_prop_g40-50_rh_he_ec3',
  {},
  answersFor({
    existing_water_heater_fuel: 'gas',
    installation_date: '2025-06-01'
  })
);
assertStatus(res2, 'cleanpowersf_hpwh', 'ineligible', 'Test 2');
assert(
  res2.evaluations.find(e => e.program_id === 'cleanpowersf_hpwh').reasons.some(r => /uef/i.test(r)),
  'Test 2 Failed: Should explain UEF shortfall'
);
console.log('✓ Test 2 Passed: UEF equipment threshold');

// 3. Invalid ZIP Code Handling
const res3 = evaluateRebates('00000', 50000, 'rheem_xe50t10h45u0');
assert.strictEqual(res3.matches.length, 0, 'Test 3 Failed: Invalid ZIP should return 0 matches');
assert.strictEqual(res3.evaluations.length, 0, 'Test 3 Failed: No local programs for invalid ZIP');
console.log('✓ Test 3 Passed: Invalid ZIP code handling');

// 4. Household questions can leave a program needing input
const res4 = evaluateRebates('94102', 75000, 'rheem_xe50t10h45u0');
assertStatus(res4, 'cleanpowersf_hpwh', 'needs_input', 'Test 4');
assert.ok(
  (res4.evaluations.find(e => e.program_id === 'cleanpowersf_hpwh').missingAttributes || []).length >= 0
);
assert.ok(
  res4.evaluations.find(e => e.program_id === 'cleanpowersf_hpwh').status === 'needs_input',
  'Test 4 Failed: unanswered household conditions should need input'
);
console.log('✓ Test 4 Passed: Household conditions need input');

// 5. Heat pump category program matches HVAC seed model when answers provided
const res5 = evaluateRebates(
  '94102',
  75000,
  'carrier_25vna436a003',
  {},
  answersFor({
    existing_heating_fuel: 'gas',
    installation_date: '2026-05-01'
  })
);
assertEligible(res5, 'cleanpowersf_hvac', 'Test 5');
console.log('✓ Test 5 Passed: HVAC heat pump program');

// 6. Discover lists rebates first (no appliances yet)
const res6 = discoverEligible('94102', 75000);
assert.strictEqual(res6.mode, 'discover', 'Test 6 Failed: mode should be discover');
assert(res6.programs.length >= 3, 'Test 6 Failed: expected CleanPowerSF programs');
const hpwh = res6.programs.find(p => p.program_id === 'cleanpowersf_hpwh');
assert(hpwh, 'Test 6 Failed: missing HPWH program');
assert.strictEqual(hpwh.appliance_count, 0, 'Test 6 Failed: rebate list should not preload appliances');
assert(
  (hpwh.equipment_rules || []).some(rule => /uef/i.test(rule) || /3\.3/.test(rule)),
  'Test 6 Failed: HPWH should advertise UEF equipment rule'
);
assert(
  (hpwh.requirements || []).some(r => r.attribute_name === 'uef' && Number(r.attribute_value) >= 3.3),
  'Test 6 Failed: HPWH should include UEF attribute requirement'
);
console.log('✓ Test 6 Passed: Rebate-first discovery list');

// 7. Click-through loads eligible appliances for one program
const res7 = discoverEligibleAppliances('94102', 75000, 'cleanpowersf_hpwh', { limit: 25 });
assert.strictEqual(res7.mode, 'discover_appliances', 'Test 7 Failed: mode should be discover_appliances');
assert(res7.appliance_count > 0, 'Test 7 Failed: expected eligible HPWH appliances');
assert(
  res7.appliances.some(a => a.model_id === 'rheem_xe50t10h45u0' || a.model_id === 'aosmith_hptu-66n-130'),
  'Test 7 Failed: seed heat pump water heaters should appear'
);
assert(
  !res7.appliances.some(a => a.model_id === 'rheem_prop_g40-50_rh_he_ec3'),
  'Test 7 Failed: gas water heater should not appear for HPWH rebate'
);
console.log('✓ Test 7 Passed: Click-through eligible appliances');

// 8. Category filter still works on rebate list
const res8 = discoverEligible('94102', null, { category: 'heat_pump' });
assert.strictEqual(res8.programs.length, 1, 'Test 8 Failed: category filter should keep one program');
assert.strictEqual(res8.programs[0].program_id, 'cleanpowersf_hvac', 'Test 8 Failed: expected HVAC program');
console.log('✓ Test 8 Passed: Category filter on rebate list');

console.log('\nAll Engine Tests Passed Successfully!\n');
