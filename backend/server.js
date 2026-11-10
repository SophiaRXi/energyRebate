const express = require('express');
const path = require('path');
const { evaluateRebates, discoverEligible } = require('./engine');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.post('/api/evaluate', (req, res) => {
  const { zipCode, income, modelId, overrides } = req.body;

  if (!zipCode || income === undefined || income === null || income === '' || !modelId) {
    return res.status(400).json({ error: 'Missing required fields: zipCode, income, modelId' });
  }

  try {
    const result = evaluateRebates(zipCode, Number(income), modelId, overrides || {});
    res.json({
      eligible: result.matches.length > 0,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/discover', (req, res) => {
  const { zipCode, income, category, brand, limit } = req.body;

  if (!zipCode || income === undefined || income === null || income === '') {
    return res.status(400).json({ error: 'Missing required fields: zipCode, income' });
  }

  try {
    const result = discoverEligible(zipCode, Number(income), {
      category: category || null,
      brand: brand || null,
      limit: limit || 25
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Scalable Rebate Engine running on http://localhost:${PORT}`);
});
