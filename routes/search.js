const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { embedQuery } = require('../embedder');
const {
  getPriorityChunks,
  hybridSearch,
  logRetrievalTrace
} = require('../vectorstore');
const {
  analyzeQuery,
  buildContextBlock,
  countSourceTypes,
  rerankCandidates,
  summarizeChunks
} = require('../retrieval');

const router = express.Router();

router.post('/', async (req, res) => {
  const { location_id, query, top_k = 5, threshold = 0.4 } = req.body;
  const desiredTopK = Number(top_k) || 5;
  const desiredThreshold = Number(threshold);

  if (!location_id || !query) {
    return res.status(400).json({ error: 'location_id and query are required' });
  }

  const startedAt = Date.now();
  const retrievalTraceId = uuidv4();

  try {
    const queryAnalysis = analyzeQuery(query);
    const queryEmbedding = await embedQuery(query);
    const priorityChunks = await getPriorityChunks(location_id);
    const priorityTypes = new Set(priorityChunks.map(chunk => chunk.source_type));
    const candidateLimit = Math.max(desiredTopK * 6, 24);

    const hybrid = await hybridSearch(location_id, queryEmbedding, query, candidateLimit, Number.isFinite(desiredThreshold) ? desiredThreshold : 0.4, {
      candidateCount: candidateLimit
    });

    const candidateResults = hybrid.rows.filter(chunk => !priorityTypes.has(chunk.source_type));
    const rerankedCandidates = rerankCandidates(query, candidateResults);
    const selectedResults = rerankedCandidates.slice(0, desiredTopK);
    const contextChunks = [...priorityChunks, ...selectedResults];
    const contextBlock = buildContextBlock(contextChunks);
    const latencyMs = Date.now() - startedAt;

    await logRetrievalTrace({
      id: retrievalTraceId,
      location_id,
      query_text: query,
      query_tokens: queryAnalysis.tokens,
      query_token_count: queryAnalysis.token_count,
      search_strategy: hybrid.strategy,
      top_k: desiredTopK,
      threshold: Number.isFinite(desiredThreshold) ? desiredThreshold : 0.4,
      priority_count: priorityChunks.length,
      vector_candidate_count: hybrid.vectorCandidateCount,
      keyword_candidate_count: hybrid.keywordCandidateCount,
      candidate_count: hybrid.rows.length,
      selected_count: selectedResults.length,
      context_chunk_count: contextChunks.length,
      priority_summary: summarizeChunks(priorityChunks),
      candidate_summary: summarizeChunks(selectedResults),
      selected_ids: selectedResults.map(chunk => chunk.id).filter(Boolean),
      selected_source_types: countSourceTypes(selectedResults),
      latency_ms: latencyMs,
      created_at: new Date().toISOString()
    }).catch(err => {
      console.warn(`[search] Retrieval trace log failed: ${err.message}`);
    });

    res.json({
      location_id,
      retrieval_trace_id: retrievalTraceId,
      search_strategy: hybrid.strategy,
      query_analysis: queryAnalysis,
      result_count: selectedResults.length,
      priority_count: priorityChunks.length,
      context_count: contextChunks.length,
      context_block: contextBlock,
      metrics: {
        latency_ms: latencyMs,
        candidate_count: hybrid.rows.length,
        vector_candidate_count: hybrid.vectorCandidateCount,
        keyword_candidate_count: hybrid.keywordCandidateCount,
        reranked_count: rerankedCandidates.length
      },
      chunks: [
        ...priorityChunks.map(chunk => ({
          url: chunk.url,
          page_title: chunk.page_title,
          similarity: null,
          source_type: chunk.source_type,
          priority: chunk.priority,
          rerank_score: null,
          preview: String(chunk.content || '').slice(0, 150) + '...'
        })),
        ...selectedResults.map(chunk => ({
          url: chunk.url,
          page_title: chunk.page_title,
          similarity: Math.round((chunk.vector_similarity ?? chunk.similarity ?? 0) * 100) / 100,
          source_type: chunk.source_type,
          priority: chunk.priority,
          rerank_score: Math.round((chunk.rerank_score ?? 0) * 1000) / 1000,
          preview: String(chunk.content || '').slice(0, 150) + '...'
        }))
      ]
    });
  } catch (err) {
    console.error('[search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
