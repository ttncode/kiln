'use strict';

const express = require('express');
const { requireAuth } = require('../auth');
const { previewWebhook } = require('../webhooks');

const router = express.Router();

router.post('/webhooks/preview', requireAuth, async (req, res) => {
  res.json(await previewWebhook(req.body.url));
});

module.exports = router;
