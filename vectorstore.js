const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function isMissingRpcFunction(error) {
  const message = [
    error?.message,
    error?.details,
    error?.hint
  ].filter(Boolean).join(' ');

  return /Could not find the function|function .* does not exist|PGRST202|42883/i.test(message);
}

function isMissingRelationError(error) {
  const message = [
    error?.message,
    error?.details,
    error?.hint
  ].filter(Boolean).join(' ');

  return /relation .* does not exist|could not find the table|PGRST205/i.test(message);
}

async function upsertChunks(locationId, chunks, embeddings, sourceType = 'website', priority = 1, sourceName = null) {
  const rows = chunks.map((chunk, i) => ({
    location_id: locationId,
    url: chunk.url,
    page_title: chunk.pageTitle,
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    embedding: JSON.stringify(embeddings[i]),
    source_type: sourceType,
    priority,
    source_name: sourceName || chunk.url
  }));

  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase
      .from('knowledge_chunks')
      .insert(rows.slice(i, i + 100));
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }
}

async function deleteChunksByUrl(locationId, url) {
  const { error } = await supabase
    .from('knowledge_chunks')
    .delete()
    .eq('location_id', locationId)
    .eq('url', url);
  if (error) throw new Error(`Delete failed: ${error.message}`);
}

async function clearChunks(locationId) {
  const { error } = await supabase
    .from('knowledge_chunks')
    .delete()
    .eq('location_id', locationId);
  if (error) throw new Error(`Clear failed: ${error.message}`);
}

async function deleteChunksBySourceType(locationId, sourceType) {
  const { error } = await supabase
    .from('knowledge_chunks')
    .delete()
    .eq('location_id', locationId)
    .eq('source_type', sourceType);
  if (error) throw new Error(`Delete failed: ${error.message}`);
}

// Replaces the full inventory snapshot for a location.
async function replaceInventoryItems(locationId, rows) {
  const { error: delError } = await supabase
    .from('inventory_items')
    .delete()
    .eq('location_id', locationId);
  if (delError) throw new Error(`Inventory clear failed: ${delError.message}`);

  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase
      .from('inventory_items')
      .insert(rows.slice(i, i + 100));
    if (error) throw new Error(`Inventory insert failed: ${error.message}`);
  }
}

async function similaritySearch(locationId, queryEmbedding, topK = 5, threshold = 0.4) {
  const { data, error } = await supabase.rpc('match_knowledge_chunks', {
    query_embedding: queryEmbedding,
    match_location_id: locationId,
    match_count: topK,
    match_threshold: threshold
  });
  if (error) throw new Error(`Search failed: ${error.message}`);
  return data || [];
}

async function hybridSearch(locationId, queryEmbedding, queryText, topK = 5, threshold = 0.4, options = {}) {
  const candidateCount = options.candidateCount || Math.max(topK * 6, 24);

  try {
    const { data, error } = await supabase.rpc('match_knowledge_chunks_hybrid', {
      query_embedding: queryEmbedding,
      query_text: queryText,
      match_location_id: locationId,
      match_count: candidateCount,
      match_threshold: threshold
    });

    if (error) throw error;

    const rows = data || [];
    const vectorCandidateCount = rows.filter(row => Number(row.vector_similarity || 0) > 0).length;
    const keywordCandidateCount = rows.filter(row => Number(row.keyword_rank || 0) > 0).length;

    return {
      rows,
      strategy: 'hybrid',
      candidateCount,
      vectorCandidateCount,
      keywordCandidateCount
    };
  } catch (error) {
    if (isMissingRpcFunction(error)) {
      const rows = await similaritySearch(locationId, queryEmbedding, candidateCount, threshold);
      return {
        rows: rows.map(row => ({
          ...row,
          vector_similarity: row.vector_similarity ?? row.similarity ?? null,
          keyword_rank: row.keyword_rank ?? null,
          hybrid_score: row.hybrid_score ?? row.similarity ?? null,
          match_reason: row.match_reason || 'vector_fallback'
        })),
        strategy: 'vector_fallback',
        candidateCount,
        vectorCandidateCount: rows.length,
        keywordCandidateCount: 0
      };
    }

    throw new Error(`Hybrid search failed: ${error.message}`);
  }
}

async function logRetrievalTrace(trace) {
  try {
    const { error } = await supabase.from('retrieval_traces').insert({
      ...trace,
      created_at: trace.created_at || new Date().toISOString()
    });

    if (error) throw new Error(`Retrieval trace log failed: ${error.message}`);
  } catch (error) {
    if (isMissingRelationError(error)) {
      return;
    }
    throw error;
  }
}

async function listRetrievalTraces(locationId, { days = 30, limit = 50 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .from('retrieval_traces')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (locationId) {
    query = query.eq('location_id', locationId);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) {
      return [];
    }
    throw new Error(`Retrieval trace read failed: ${error.message}`);
  }
  return data || [];
}

async function logRetrievalFeedback({ traceId, locationId, rating, notes = null }) {
  if (!traceId || !locationId || !rating) {
    throw new Error('traceId, locationId and rating are required');
  }

  try {
    const { error } = await supabase.from('retrieval_feedback').insert({
      trace_id: traceId,
      location_id: locationId,
      rating,
      notes,
      created_at: new Date().toISOString()
    });

    if (error) throw new Error(`Retrieval feedback log failed: ${error.message}`);
  } catch (error) {
    if (isMissingRelationError(error)) {
      return;
    }
    throw error;
  }
}

async function listRetrievalFeedback(locationId, { days = 30, limit = 100 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .from('retrieval_feedback')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (locationId) {
    query = query.eq('location_id', locationId);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) {
      return [];
    }
    throw new Error(`Retrieval feedback read failed: ${error.message}`);
  }
  return data || [];
}

async function getPriorityChunks(locationId, sourceTypes = ['profile', 'inventory_summary']) {
  const { data, error } = await supabase
    .from('knowledge_chunks')
    .select('id, url, page_title, content, source_type, priority, source_name')
    .eq('location_id', locationId)
    .in('source_type', sourceTypes)
    .order('priority', { ascending: false });

  if (error) throw new Error(`Priority lookup failed: ${error.message}`);
  return data || [];
}

async function getChunkSummary(locationId) {
  const { data, error } = await supabase
    .from('knowledge_chunks')
    .select('url, page_title, chunk_index, source_type, created_at')
    .eq('location_id', locationId)
    .order('url');
  if (error) throw error;
  return data || [];
}

// Jobs
async function createJob(jobId, locationId, url) {
  const { error } = await supabase.from('scrape_jobs').insert({
    id: jobId,
    location_id: locationId,
    start_url: url,
    status: 'pending',
    created_at: new Date().toISOString()
  });
  if (error) throw error;
}

async function updateJob(jobId, updates) {
  const { error } = await supabase
    .from('scrape_jobs')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) throw error;
}

async function getJob(jobId) {
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  upsertChunks,
  deleteChunksByUrl,
  deleteChunksBySourceType,
  clearChunks,
  replaceInventoryItems,
  similaritySearch,
  hybridSearch,
  logRetrievalTrace,
  listRetrievalTraces,
  logRetrievalFeedback,
  listRetrievalFeedback,
  getPriorityChunks,
  getChunkSummary,
  createJob,
  updateJob,
  getJob
};
