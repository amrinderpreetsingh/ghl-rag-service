const express = require('express');
const { embedQuery } = require('../embedder');
const { similaritySearch } = require('../vectorstore');

const router = express.Router();

// POST /search
// Body: { location_id, query, top_k? }
router.post('/', async (req, res) => {
  const { location_id, query, top_k = 5, threshold = 0.4 } = req.body;

  if (!location_id || !query) {
    return res.status(400).json({ error: 'location_id and query are required' });
  }

  try {
    const queryEmbedding = await embedQuery(query);
    const results = await similaritySearch(location_id, queryEmbedding, top_k, threshold);

    const contextBlock = results.length
      ? results
          .sort((a, b) => b.priority - a.priority || b.similarity - a.similarity)
          .map(r => `[${r.page_title || r.url}]\n${r.content}`)
          .join('\n\n---\n\n')
      : '';

    res.json({
      location_id,
      result_count: results.length,
      context_block: contextBlock,
      chunks: results.map(r => ({
        url: r.url,
        page_title: r.page_title,
        similarity: Math.round(r.similarity * 100) / 100,
        source_type: r.source_type,
        priority: r.priority,
        preview: r.content.slice(0, 150) + '...'
      }))
    });
  } catch (err) {
    console.error('[search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
