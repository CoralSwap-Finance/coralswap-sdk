const express = require('express');
const router = express.Router();

router.post('/issue', (req, res) => {
  const { recipient, courseId, issuer } = req.body;
  return res.status(201).json({
    success: true,
    credentialId: 'cred_' + Math.random().toString(36).substring(2, 15),
    recipient,
    courseId,
    issuer,
    network: 'stellar-testnet',
    timestamp: new Date().toISOString()
  });
});

router.get('/:id', (req, res) => {
  const { id } = req.params;
  return res.status(200).json({
    credentialId: id,
    verified: true,
    issuer: 'AetherMint Academy',
    revoked: false
  });
});

module.exports = router;
