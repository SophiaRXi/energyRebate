const eligibilityRules = [
    [
      'rule',
      ['eligible_rebate', 'ModelID', 'ProgramID', 'Amount'],
      ['appliance_spec', 'ModelID', 'Category', 'Efficiency'],
      ['rebate_program', 'ProgramID', 'ZipCode', 'Category', 'MinEfficiency', 'IncomeCap', 'Amount'],
      ['user_zip', 'ZipCode'],
      ['user_income', 'Income'],
      ['less', 'Income', 'IncomeCap'],
      ['not', ['less', 'Efficiency', 'MinEfficiency']]
    ]
  ];
  
  module.exports = { eligibilityRules };