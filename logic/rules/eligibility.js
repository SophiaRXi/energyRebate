const eligibilityRules = [
    [
      'rule',
      ['eligible_rebate', 'ModelID', 'ProgramID', 'Amount'],
      ['appliance', 'ModelID'],
      ['appliance_type', 'ModelID', 'Category'],
      ['or',
        ['appliance_efficiency', 'ModelID', 'Efficiency'],
        ['appliance_uef', 'ModelID', 'Efficiency']
      ],
      ['rebate_program', 'ProgramID', 'ZipCode', 'Category', 'MinEfficiency', 'IncomeCap', 'Amount'],
      ['user_zip', 'ZipCode'],
      ['user_income', 'Income'],
      ['less', 'Income', 'IncomeCap'],
      ['not', ['less', 'Efficiency', 'MinEfficiency']]
    ]
  ];
  
  module.exports = { eligibilityRules };