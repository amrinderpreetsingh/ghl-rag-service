const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { chunkText } = require('../chunker');
const { embedTexts } = require('../embedder');
const {
  upsertChunks,
  deleteChunksByUrl,
  deleteChunksBySourceType,
  clearChunks,
  replaceInventoryItems,
  createJob,
  updateJob
} = require('../vectorstore');
const {
  extractInventoryConfig,
  fetchDealerInventory,
  buildItemUrl,
  itemTitle,
  formatItemForEmbedding,
  toInventoryRow,
  summarizeInventory,
  formatInventorySummaryText
} = require('../inventory');
const {
  safeUrl,
  collectSiteFacts,
  buildClientProfileText,
  discoverSupplementalUrls,
  shouldChunkPage,
  htmlToText,
  extractTitle
} = require('../site-intel');

const router = express.Router();

const FIRECRAWL_URL = process.env.FIRECRAWL_URL;
const FIRECRAWL_KEY = process.env.FIRECRAWL_KEY || 'dummy-key';
const FIRECRAWL_LIMIT = Number(process.env.FIRECRAWL_LIMIT || 100);
const SUPPLEMENTAL_LIMIT = Number(process.env.CRAWL_SUPPLEMENTAL_LIMIT || 10);

function syntheticUrl(startUrl, suffix) {
  return new URL(suffix, `${new URL(startUrl).origin}/`).href;
}

async function fetchHtmlPage(url) {
  const res = await axios.get(url, {
    timeout: 25000,
    responseType: 'text',
    transformResponse: [data => data],
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ghl-rag-service/1.0)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  return String(res.data || '');
}

async function upsertSingleChunk(locationId, chunk, embedding, sourceType, priority, sourceName = null) {
  await upsertChunks(
    locationId,
    [chunk],
    [embedding],
    sourceType,
    priority,
    sourceName || chunk.url
  );
}

async function processInventory(locationId, startUrl, inventoryConfig) {
  const origin = new URL(startUrl).origin;

  if (!inventoryConfig) {
    try {
      const res = await axios.get(`${origin}/inventory`, {
        timeout: 30000,
        responseType: 'text',
        transformResponse: [data => data],
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      inventoryConfig = extractInventoryConfig(res.data);
    } catch {
      // no /inventory page — site simply has no TRM inventory
    }
  }

  if (!inventoryConfig) {
    console.log('[scrape] No dealer inventory widget detected');
    return { chunkCount: 0, summary: null };
  }

  console.log(`[scrape] Inventory widget detected (websiteId: ${inventoryConfig.websiteId})`);

  const data = await fetchDealerInventory(inventoryConfig.apiKey, inventoryConfig.websiteId);
  const items = data.inventoryItems || [];
  console.log(`[scrape] Fetched ${items.length} inventory items`);

  const rows = items.map(item =>
    toInventoryRow(locationId, item, buildItemUrl(origin, inventoryConfig.dynamicPageName, item))
  );
  await replaceInventoryItems(locationId, rows);

  await deleteChunksBySourceType(locationId, 'inventory');
  await deleteChunksBySourceType(locationId, 'inventory_summary');

  let itemChunkCount = 0;
  if (items.length) {
    const urlCounts = {};
    const chunks = items.map(item => {
      const url = buildItemUrl(origin, inventoryConfig.dynamicPageName, item);
      const chunkIndex = urlCounts[url] || 0;
      urlCounts[url] = chunkIndex + 1;
      return {
        content: formatItemForEmbedding(item, data.dealerPriceLabel),
        chunkIndex,
        url,
        pageTitle: itemTitle(item)
      };
    });

    const embeddings = await embedTexts(chunks.map(chunk => chunk.content));
    await upsertChunks(locationId, chunks, embeddings, 'inventory', 2, `${origin}/inventory`);
    itemChunkCount = chunks.length;
  }

  const summary = summarizeInventory(items, data.dealerPriceLabel, origin, inventoryConfig.dynamicPageName);
  const summaryText = formatInventorySummaryText(summary, `${origin}/inventory`);
  const summaryUrl = syntheticUrl(startUrl, '/__inventory-summary');
  const summaryChunk = {
    content: summaryText,
    chunkIndex: 0,
    url: summaryUrl,
    pageTitle: 'Inventory Summary'
  };
  const summaryEmbedding = await embedTexts([summaryText]);
  await upsertSingleChunk(locationId, summaryChunk, summaryEmbedding[0], 'inventory_summary', 3, `${origin}/inventory`);

  console.log(`[scrape] ✓ Inventory → ${rows.length} items, ${itemChunkCount + 1} chunks`);
  return {
    chunkCount: itemChunkCount + 1,
    summary,
    inventoryConfig
  };
}

async function processCrawl(jobId, locationId, startUrl) {
  try {
    if (!FIRECRAWL_URL) {
      throw new Error('FIRECRAWL_URL is required');
    }

    await updateJob(jobId, { status: 'crawling' });

    console.log(`[scrape] Starting Firecrawl crawl for ${startUrl}`);
    const crawlRes = await axios.post(
      `${FIRECRAWL_URL}/v1/crawl`,
      {
        url: startUrl,
        limit: FIRECRAWL_LIMIT,
        scrapeOptions: { formats: ['markdown', 'rawHtml'] }
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

    let pages = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000));

      const statusRes = await axios.get(
        `${FIRECRAWL_URL}/v1/crawl/${crawlId}`,
        { headers: { 'Authorization': `Bearer ${FIRECRAWL_KEY}` } }
      );

      const { status, data } = statusRes.data;
      console.log(`[scrape] Firecrawl status: ${status}, pages: ${data?.length || 0}`);

      if (status === 'completed') {
        pages = data || [];
        break;
      }

      if (status === 'failed') {
        throw new Error('Firecrawl crawl failed');
      }
    }

    if (!pages.length) throw new Error('No pages returned from Firecrawl');

    await updateJob(jobId, { pages_found: pages.length, status: 'embedding' });

    const pageRecords = [];
    const processedUrls = new Set();
    let inventoryConfig = null;
    let totalChunks = 0;
    let processedPages = 0;

    for (const page of pages) {
      const rawHtml = page.rawHtml || page.html || '';
      const markdown = page.markdown || '';
      const url = safeUrl(page.metadata?.sourceURL || startUrl, startUrl) || startUrl;
      const title = page.metadata?.title || page.metadata?.sourceURL || extractTitle(rawHtml) || url;

      if (!inventoryConfig) {
        inventoryConfig = extractInventoryConfig(rawHtml);
      }

      pageRecords.push({
        url,
        title,
        rawHtml,
        markdown,
        source: 'firecrawl',
        metadata: page.metadata || {}
      });

      processedUrls.add(url);
      processedPages += 1;

      if (!shouldChunkPage(url, title, markdown)) {
        await updateJob(jobId, { pages_scraped: processedPages, chunks_created: totalChunks });
        continue;
      }

      await deleteChunksByUrl(locationId, url);
      const chunks = chunkText(markdown || htmlToText(rawHtml), title, url);
      if (!chunks.length) {
        await updateJob(jobId, { pages_scraped: processedPages, chunks_created: totalChunks });
        continue;
      }

      const embeddings = await embedTexts(chunks.map(chunk => chunk.content));
      await upsertChunks(locationId, chunks, embeddings, 'website', 1, url);
      totalChunks += chunks.length;

      console.log(`[scrape] ✓ ${title} → ${chunks.length} chunks`);
      await updateJob(jobId, { pages_scraped: processedPages, chunks_created: totalChunks });
    }

    const supplementalUrls = await discoverSupplementalUrls(startUrl, [...processedUrls], SUPPLEMENTAL_LIMIT);
    let supplementalCount = 0;

    for (const supplementalUrl of supplementalUrls) {
      const url = safeUrl(supplementalUrl, startUrl);
      if (!url || processedUrls.has(url)) continue;

      try {
        const html = await fetchHtmlPage(url);
        const text = htmlToText(html);
        const title = extractTitle(html) || url;

        if (!inventoryConfig) {
          inventoryConfig = extractInventoryConfig(html);
        }

        pageRecords.push({
          url,
          title,
          rawHtml: html,
          markdown: text,
          source: 'supplemental',
          metadata: { sourceURL: url, title }
        });

        processedUrls.add(url);
        processedPages += 1;
        supplementalCount += 1;

        if (!shouldChunkPage(url, title, text)) {
          await updateJob(jobId, { pages_scraped: processedPages, chunks_created: totalChunks });
          continue;
        }

        await deleteChunksByUrl(locationId, url);
        const chunks = chunkText(text, title, url);
        if (!chunks.length) {
          await updateJob(jobId, { pages_scraped: processedPages, chunks_created: totalChunks });
          continue;
        }

        const embeddings = await embedTexts(chunks.map(chunk => chunk.content));
        await upsertChunks(locationId, chunks, embeddings, 'website', 1, url);
        totalChunks += chunks.length;

        console.log(`[scrape] ✓ supplemental ${title} → ${chunks.length} chunks`);
        await updateJob(jobId, { pages_scraped: processedPages, chunks_created: totalChunks });
      } catch (err) {
        console.warn(`[scrape] Supplemental fetch failed for ${supplementalUrl}: ${err.message}`);
      }
    }

    let inventorySummary = null;
    try {
      const inventoryResult = await processInventory(locationId, startUrl, inventoryConfig);
      totalChunks += inventoryResult.chunkCount;
      inventorySummary = inventoryResult.summary;
    } catch (err) {
      console.error('[scrape] Inventory ingestion failed:', err.message);
    }

    const facts = collectSiteFacts(pageRecords, startUrl);
    const businessName = facts.businessName || new URL(startUrl).hostname.replace(/^www\./i, '');
    const profileText = buildClientProfileText({
      startUrl,
      businessName,
      facts,
      pageCount: pageRecords.length,
      supplementalCount,
      inventorySummary
    });

    await deleteChunksBySourceType(locationId, 'profile');
    const profileUrl = syntheticUrl(startUrl, '/__profile');
    const profileChunk = {
      content: profileText,
      chunkIndex: 0,
      url: profileUrl,
      pageTitle: 'Client Profile'
    };
    const profileEmbedding = await embedTexts([profileText]);
    await upsertSingleChunk(locationId, profileChunk, profileEmbedding[0], 'profile', 4, `${new URL(startUrl).origin}/profile`);

    totalChunks += 1;

    await updateJob(jobId, {
      status: 'done',
      pages_found: pageRecords.length,
      pages_scraped: processedPages,
      chunks_created: totalChunks,
      completed_at: new Date().toISOString()
    });

    console.log(`[scrape] Done — ${pageRecords.length} pages, ${totalChunks} chunks`);
  } catch (err) {
    console.error(`[scrape] Job ${jobId} failed:`, err.message);
    await updateJob(jobId, { status: 'failed', error: err.message });
  }
}

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
