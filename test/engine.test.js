const { evaluateRebates } = require('../backend/engine');
const assert = require('assert');

console.log('Running Logic Engine Diagnostics...\n');

// 1. Basic Eligibility Test
const res1 = evaluateRebates('94102', 75000, 'AHRI-101');
assert(Array.isArray(res1), 'Test 1 Failed: Expected output to be an array');
assert(res1.length > 0, 'Test 1 Failed: Should find eligible heat pump rebate');
console.log('✓ Test 1 Passed: Base rebate evaluation');

// 2. Income Cap Enforcement
const res2 = evaluateRebates('94102', 150000, 'AHRI-101');
assert.strictEqual(res2.length, 0, 'Test 2 Failed: High income should return 0 rebates');
console.log('✓ Test 2 Passed: Income cap enforcement');

// 3. Invalid ZIP Code Handling
const res3 = evaluateRebates('00000', 50000, 'AHRI-101');
assert.strictEqual(res3.length, 0, 'Test 3 Failed: Invalid ZIP should return 0 rebates');
console.log('✓ Test 3 Passed: Invalid ZIP code handling');

// 4. Water heaters with different attribute sets, looked up in original case
const res4 = evaluateRebates('94102', 75000, 'Rheem_XE40H06TT45U0');
assert(res4.some(m => m.program_id === 'pg_94102_wh'), 'Test 4 Failed: Rheem water heater should match');
const res5 = evaluateRebates('94102', 75000, 'FRIEDRICH_PROP_G40-50_RH_HE_EC3');
assert(res5.some(m => m.program_id === 'pg_94102_wh'), 'Test 5 Failed: Friedrich water heater should match');
console.log('✓ Tests 4-5 Passed: Water heaters with optional attributes');

console.log('\nAll Engine Tests Passed Successfully!\n');