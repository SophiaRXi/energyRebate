const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/rebates.db'));

function getCandidateFacts(modelId, zipCode) {
  // Model ids are stored lowercase so Epilog can use them as constants.
  const appliance = db.prepare(
    `SELECT model_id, category, brand, efficiency_rating
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
    `SELECT program_id, zip_code, category, min_efficiency, income_cap, amount
     FROM rebates
     WHERE CAST(zip_code AS TEXT) = ? AND category = ?`
  ).all(String(zipCode), appliance.category);

  return { appliance, attributes, candidateRebates };
}

module.exports = { getCandidateFacts };