const express = require('express');
const {
  listRetrievalTraces,
  listRetrievalFeedback,
  logRetrievalFeedback
} = require('../vectorstore');

const router = express.Router();

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * pct;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function mergeSourceTypes(traces) {
  const counts = {};
  for (const trace of traces) {
    for (const summary of [...(trace.priority_summary || []), ...(trace.candidate_summary || [])]) {
      const type = String(summary.source_type || 'unknown');
      counts[type] = (counts[type] || 0) + 1;
    }
  }
  return counts;
}

function mergeStrategyCounts(traces) {
  const counts = {};
  for (const trace of traces) {
    const strategy = String(trace.search_strategy || 'unknown');
    counts[strategy] = (counts[strategy] || 0) + 1;
  }
  return counts;
}

function mergeTopQueries(traces, limit = 10) {
  const counts = new Map();
  for (const trace of traces) {
    const query = String(trace.query_text || '').trim();
    if (!query) continue;
    counts.set(query, (counts.get(query) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([query, count]) => ({ query, count }));
}

router.get('/retrieval', async (req, res) => {
  const { location_id: locationId = null, days = 30, limit = 100 } = req.query;

  try {
    const traces = await listRetrievalTraces(locationId, {
      days: Number(days) || 30,
      limit: Number(limit) || 100
    });
    const feedback = await listRetrievalFeedback(locationId, {
      days: Number(days) || 30,
      limit: Number(limit) || 100
    });

    const latencies = traces
      .map(trace => Number(trace.latency_ms))
      .filter(value => Number.isFinite(value));
    const selectedCounts = traces
      .map(trace => Number(trace.selected_count))
      .filter(value => Number.isFinite(value));
    const candidateCounts = traces
      .map(trace => Number(trace.candidate_count))
      .filter(value => Number.isFinite(value));
    const priorityCounts = traces
      .map(trace => Number(trace.priority_count))
      .filter(value => Number.isFinite(value));
    const tokenCounts = traces
      .map(trace => Number(trace.query_token_count))
      .filter(value => Number.isFinite(value));
    const p95Latency = percentile(latencies, 0.95);
    const ratingValues = feedback
      .map(entry => Number(entry.rating))
      .filter(value => Number.isFinite(value));

    res.json({
      location_id: locationId,
      window_days: Number(days) || 30,
      total_queries: traces.length,
      hybrid_usage: traces.length
        ? Math.round((traces.filter(trace => trace.search_strategy === 'hybrid').length / traces.length) * 1000) / 10
        : 0,
      avg_latency_ms: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      p95_latency_ms: p95Latency == null ? null : Math.round(p95Latency),
      avg_selected_count: selectedCounts.length ? Math.round((selectedCounts.reduce((sum, value) => sum + value, 0) / selectedCounts.length) * 10) / 10 : null,
      avg_candidate_count: candidateCounts.length ? Math.round((candidateCounts.reduce((sum, value) => sum + value, 0) / candidateCounts.length) * 10) / 10 : null,
      avg_priority_count: priorityCounts.length ? Math.round((priorityCounts.reduce((sum, value) => sum + value, 0) / priorityCounts.length) * 10) / 10 : null,
      avg_query_tokens: tokenCounts.length ? Math.round((tokenCounts.reduce((sum, value) => sum + value, 0) / tokenCounts.length) * 10) / 10 : null,
      feedback_count: feedback.length,
      avg_feedback_rating: ratingValues.length ? Math.round((ratingValues.reduce((sum, value) => sum + value, 0) / ratingValues.length) * 10) / 10 : null,
      search_strategies: mergeStrategyCounts(traces),
      source_types: mergeSourceTypes(traces),
      top_queries: mergeTopQueries(traces),
      recent_traces: traces.slice(0, 20).map(trace => ({
        id: trace.id,
        created_at: trace.created_at,
        query_text: trace.query_text,
        search_strategy: trace.search_strategy,
        latency_ms: trace.latency_ms,
        selected_count: trace.selected_count,
        candidate_count: trace.candidate_count,
        priority_count: trace.priority_count,
        selected_source_types: trace.selected_source_types || {}
      })),
      recent_feedback: feedback.slice(0, 20).map(entry => ({
        id: entry.id,
        trace_id: entry.trace_id,
        created_at: entry.created_at,
        rating: entry.rating,
        notes: entry.notes
      }))
    });
  } catch (err) {
    console.error('[metrics] Retrieval metrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/retrieval/feedback', async (req, res) => {
  const { trace_id: traceId, location_id: locationId, rating, notes = null } = req.body;

  if (!traceId || !locationId || rating == null) {
    return res.status(400).json({ error: 'trace_id, location_id and rating are required' });
  }

  try {
    await logRetrievalFeedback({
      traceId,
      locationId,
      rating: Number(rating),
      notes
    });

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[metrics] Retrieval feedback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
