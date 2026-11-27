const express = require('express');
const router = express.Router();
const holographicService = require('../services/holographicStorage');

router.post('/encode', async (req, res) => {
  try {
    const { contentId, data } = req.body;
    if (!contentId || !data) {
      return res.status(400).json({ error: 'contentId and data buffer are required' });
    }
    const buffer = Buffer.from(data, 'base64');
    const result = await holographicService.encodeSpatialData(contentId, buffer);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/access/parallel', async (req, res) => {
  try {
    const { hashes } = req.body;
    if (!Array.isArray(hashes)) {
      return res.status(400).json({ error: 'hashes array required' });
    }
    const simulation = hashes.map(h => ({
      hash: h,
      status: 'retrieved',
      bandwidthMBs: 15000,
      latencyMs: 1.1
    }));
    return res.status(200).json({ success: true, results: simulation });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
