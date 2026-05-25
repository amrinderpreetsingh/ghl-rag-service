const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
      .upsert(rows.slice(i, i + 100), { onConflict: 'location_id,url,chunk_index' });
    if (error) throw new Error(`Upsert failed: ${error.message}`);
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
  clearChunks,
  similaritySearch,
  getChunkSummary,
  createJob,
  updateJob,
  getJob
};
