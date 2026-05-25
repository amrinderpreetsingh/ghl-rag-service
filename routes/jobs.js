const express = require('express');
const { getJob } = require('../vectorstore');

const router = express.Router();

// GET /jobs/:id
router.get('/:id', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
