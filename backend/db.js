const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/rebates.db'));

function getCandidateFacts(modelId, zipCode) {
  // Cast inputs and comparisons explicitly to string
  const appliance = db.prepare(
    'SELECT model_id, category, efficiency_rating FROM appliances WHERE model_id = ?'
  ).get(String(modelId));

  if (!appliance) return null;

  const candidateRebates = db.prepare(
    'SELECT program_id, zip_code, category, min_efficiency, income_cap, amount FROM rebates WHERE CAST(zip_code AS TEXT) = ? AND category = ?'
  ).all(String(zipCode), appliance.category);

  return { appliance, candidateRebates };
}

module.exports = { getCandidateFacts };