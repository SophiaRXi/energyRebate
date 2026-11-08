const express = require('express');
const path = require('path');
const { evaluateRebates } = require('./engine');

const app = express();

app.use(express.json());
// Serve static files from frontend/public
app.use(express.static(path.join(__dirname, '../frontend/public')));

// Explicit route for home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.post('/api/evaluate', (req, res) => {
  const { zipCode, income, modelId } = req.body;

  if (!zipCode || !income || !modelId) {
    return res.status(400).json({ error: 'Missing required fields: zipCode, income, modelId' });
  }

  try {
    const matches = evaluateRebates(zipCode, Number(income), modelId);
    res.json({ eligible: matches.length > 0, matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Scalable Rebate Engine running on http://localhost:${PORT}`);
});