const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/rebates.db'));

function getCandidateFacts(modelId, zipCode) {
  const appliance = db.prepare(
    `SELECT model_id, category, brand
     FROM appliances
     WHERE LOWER(model_id) = LOWER(?)`
  ).get(String(modelId));

  if (!appliance) return null;

  const attributes = db.prepare(
    `SELECT attribute_name, attribute_value
     FROM appliance_attributes
     WHERE model_id = ?`
  ).all(appliance.model_id);

  const candidateRebates = db.prepare(
    `SELECT program_id, zip_code, category, income_cap, amount
     FROM rebates
     WHERE CAST(zip_code AS TEXT) = ? AND category = ?`
  ).all(String(zipCode), appliance.category);

  const programIds = candidateRebates.map(r => r.program_id);
  let requirements = [];
  if (programIds.length > 0) {
    const placeholders = programIds.map(() => '?').join(', ');
    requirements = db.prepare(
      `SELECT program_id, attribute_name, operator, attribute_value
       FROM rebate_requirements
       WHERE program_id IN (${placeholders})`
    ).all(...programIds);
  }

  return { appliance, attributes, candidateRebates, requirements };
}

module.exports = { getCandidateFacts };
