const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { chunkText } = require('../chunker');
const { embedTexts } = require('../embedder');
const { upsertChunks, deleteChunksByUrl, clearChunks, createJob, updateJob } = require('../vectorstore');

const router = express.Router();

const FIRECRAWL_URL = process.env.FIRECRAWL_URL; // https://zucchini-nurturing-production-dee9.up.railway.app
const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY || 'dummy-key'; // firecrawl-simple doesn't enforce auth but needs a value

async function processCrawl(jobId, locationId, startUrl) {
  try {
    await updateJob(jobId, { status: 'crawling' });

    // 1. Kick off Firecrawl crawl
    console.log(`[scrape] Starting Firecrawl crawl for ${startUrl}`);
    const crawlRes = await axios.post(
      `${FIRECRAWL_URL}/v1/crawl`,
      {
        url: startUrl,
        limit: 60,
        scrapeOptions: { formats: ['markdown'] }
      },
      {
        headers: {
          'Authorization': `Bearer ${FIRECRAWL_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    const crawlId = crawlRes.data.id;
    console.log(`[scrape] Firecrawl job ID: ${crawlId}`);
    await updateJob(jobId, { status: 'scraping', current_url: startUrl });

    // 2. Poll until done
    let pages = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000)); // wait 5s between polls

      const statusRes = await axios.get(
        `${FIRECRAWL_URL}/v1/crawl/${crawlId}`,
        { headers: { 'Authorization': `Bearer ${FIRECRAWL_KEY}` } }
      );

      const { status, data } = statusRes.data;
      console.log(`[scrape] Firecrawl status: ${status}, pages: ${data?.length || 0}`);

      if (status === 'completed') {
        pages = data || [];
        break;
      } else if (status === 'failed') {
        throw new Error('Firecrawl crawl failed');
      }
    }

    if (!pages.length) throw new Error('No pages returned from Firecrawl');

    await updateJob(jobId, { pages_found: pages.length, status: 'embedding' });

    // 3. Chunk + embed + store each page
    let totalChunks = 0;
    for (const page of pages) {
      const markdown = page.markdown || '';
      const title = page.metadata?.title || page.metadata?.sourceURL || '';
      const url = page.metadata?.sourceURL || startUrl;

      if (!markdown || markdown.split(/\s+/).length < 30) continue;

      await deleteChunksByUrl(locationId, url);

      const chunks = chunkText(markdown, title, url);
      if (!chunks.length) continue;

      const embeddings = await embedTexts(chunks.map(c => c.content));
      await upsertChunks(locationId, chunks, embeddings, 'website', 1, url);

      totalChunks += chunks.length;
      console.log(`[scrape] ✓ ${title} → ${chunks.length} chunks`);

      await updateJob(jobId, { pages_scraped: totalChunks, chunks_created: totalChunks });
    }

    await updateJob(jobId, {
      status: 'done',
      chunks_created: totalChunks,
      completed_at: new Date().toISOString()
    });

    console.log(`[scrape] Done — ${pages.length} pages, ${totalChunks} chunks`);
  } catch (err) {
    console.error(`[scrape] Job ${jobId} failed:`, err.message);
    await updateJob(jobId, { status: 'failed', error: err.message });
  }
}

// POST /scrape
// Body: { url, location_id, clear_existing? }
router.post('/', async (req, res) => {
  const { url, location_id, clear_existing = true } = req.body;

  if (!url || !location_id) {
    return res.status(400).json({ error: 'url and location_id are required' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const jobId = uuidv4();

  try {
    await createJob(jobId, location_id, url);
    if (clear_existing) await clearChunks(location_id);

    // Fire async — don't await
    setImmediate(() => processCrawl(jobId, location_id, url));

    res.status(202).json({
      job_id: jobId,
      message: 'Scrape started',
      poll_url: `/jobs/${jobId}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
