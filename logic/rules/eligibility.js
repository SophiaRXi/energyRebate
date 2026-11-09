// Core eligibility. Program-specific attribute checks are encoded as
// rebate_req_gte / rebate_req_eq facts and enforced by the missing/failed rules.
const eligibilityRules = [
  [
    'rule',
    ['eligible_rebate', 'ModelID', 'ProgramID', 'Amount'],
    ['appliance', 'ModelID'],
    ['appliance_type', 'ModelID', 'Category'],
    ['rebate_program', 'ProgramID', 'ZipCode', 'Category', 'IncomeCap', 'Amount'],
    ['user_zip', 'ZipCode'],
    ['user_income', 'Income'],
    ['less', 'Income', 'IncomeCap'],
    ['not', ['missing_requirement', 'ModelID', 'ProgramID']],
    ['not', ['failed_requirement', 'ModelID', 'ProgramID']]
  ],

  // Missing: program asks for an attribute the appliance does not have at all.
  [
    'rule',
    ['missing_requirement', 'ModelID', 'ProgramID'],
    ['rebate_req_gte', 'ProgramID', 'Attr', 'Min'],
    ['not', ['appliance_attr', 'ModelID', 'Attr', 'Any']]
  ],
  [
    'rule',
    ['missing_requirement', 'ModelID', 'ProgramID'],
    ['rebate_req_eq', 'ProgramID', 'Attr', 'Required'],
    ['not', ['appliance_attr', 'ModelID', 'Attr', 'Any']]
  ],

  // Failed gte: attribute exists, but no value meets the minimum.
  [
    'rule',
    ['meets_gte', 'ModelID', 'Attr', 'Min'],
    ['appliance_attr', 'ModelID', 'Attr', 'Val'],
    ['not', ['less', 'Val', 'Min']]
  ],
  [
    'rule',
    ['failed_requirement', 'ModelID', 'ProgramID'],
    ['rebate_req_gte', 'ProgramID', 'Attr', 'Min'],
    ['appliance_attr', 'ModelID', 'Attr', 'Dummy'],
    ['not', ['meets_gte', 'ModelID', 'Attr', 'Min']]
  ],

  // Failed eq: attribute exists, but none of its values equal the required one.
  [
    'rule',
    ['failed_requirement', 'ModelID', 'ProgramID'],
    ['rebate_req_eq', 'ProgramID', 'Attr', 'Required'],
    ['appliance_attr', 'ModelID', 'Attr', 'Dummy'],
    ['not', ['appliance_attr', 'ModelID', 'Attr', 'Required']]
  ],

  // Explanation helpers used by diagnostics / future UI queries.
  [
    'rule',
    ['missing_attr', 'ModelID', 'ProgramID', 'Attr'],
    ['rebate_req_gte', 'ProgramID', 'Attr', 'Min'],
    ['not', ['appliance_attr', 'ModelID', 'Attr', 'Any']]
  ],
  [
    'rule',
    ['missing_attr', 'ModelID', 'ProgramID', 'Attr'],
    ['rebate_req_eq', 'ProgramID', 'Attr', 'Required'],
    ['not', ['appliance_attr', 'ModelID', 'Attr', 'Any']]
  ]
];

module.exports = { eligibilityRules };
