// Structured inventory ingestion for dealer sites built by True Radius
// Marketing (Duda sites with a TRM inventory widget). The widget loads the
// full inventory from a public JSON API; we extract its credentials from the
// static page HTML — no browser rendering needed.

const axios = require('axios');

const API_KEY_RE = /getWebsiteDealerInventory\?apiKey=([0-9a-fA-F-]{36})/;
const WIDGET_CONFIG_RE = /data-widget-config=\\?"([A-Za-z0-9+/=]+)\\?"/g;

// Returns { apiKey, websiteId, dynamicPageName } or null if the page
// doesn't contain a TRM inventory widget.
function extractInventoryConfig(html) {
  if (!html) return null;
  // Duda sometimes serves page data as JSON; the widget markup is still
  // embedded inside, so search the serialized form.
  if (typeof html !== 'string') html = JSON.stringify(html);

  const apiKeyMatch = html.match(API_KEY_RE);
  if (!apiKeyMatch) return null;

  // The websiteId lives in a base64-encoded JSON blob on the widget element.
  for (const m of html.matchAll(WIDGET_CONFIG_RE)) {
    try {
      const cfg = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      if (cfg.websiteKey) {
        return {
          apiKey: apiKeyMatch[1],
          websiteId: cfg.websiteKey,
          dynamicPageName: cfg.dynamicPageName || 'product'
        };
      }
    } catch {
      // not the widget we're looking for
    }
  }
  return null;
}

async function fetchDealerInventory(apiKey, websiteId) {
  const res = await axios.get(
    'https://trmdbpublicwebprod.azurewebsites.net/inventory/getWebsiteDealerInventory',
    { params: { apiKey, websiteId }, timeout: 30000 }
  );
  return res.data; // { inventoryDisplayTypeId, dealerPriceLabel, priceStaticText, inventoryItems }
}

function buildItemUrl(siteOrigin, dynamicPageName, item) {
  if (!item.pageItemUrl) return siteOrigin;
  return `${siteOrigin}/${dynamicPageName}/${item.pageItemUrl}`;
}

function itemTitle(item) {
  return [item.brand, item.productName || item.modelName].filter(Boolean).join(' ');
}

function parsePrice(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function tally(map, key) {
  const normalized = key ? String(key).trim() : '';
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) || 0) + 1);
}

function topCounts(map, limit = 5) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function summarizeInventory(items, priceLabel = null, siteOrigin = null, dynamicPageName = 'product') {
  const brandCounts = new Map();
  const categoryCounts = new Map();
  const conditionCounts = new Map();
  const prices = [];

  const featuredItems = items.slice(0, 5).map(item => ({
    title: itemTitle(item),
    price: item.priceCashDisplay || item.priceCash || item.modelMSRPDisplay || item.modelMSRP || null,
    url: siteOrigin ? buildItemUrl(siteOrigin, dynamicPageName, item) : null,
    condition: item.usage || null
  }));

  for (const item of items) {
    tally(brandCounts, item.brand);
    tally(categoryCounts, item.productCategoryType || item.category);
    tally(conditionCounts, item.usage);

    const price = parsePrice(item.priceCash ?? item.priceCashDisplay ?? item.modelMSRP ?? item.modelMSRPDisplay);
    if (price != null) prices.push(price);
  }

  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const avgPrice = prices.length
    ? Math.round(prices.reduce((sum, value) => sum + value, 0) / prices.length)
    : null;

  return {
    itemCount: items.length,
    brandCounts: topCounts(brandCounts, 8),
    categoryCounts: topCounts(categoryCounts, 8),
    conditionCounts: topCounts(conditionCounts, 5),
    priceRange: minPrice != null ? { min: minPrice, max: maxPrice, avg: avgPrice } : null,
    priceLabel: priceLabel || 'Price',
    featuredItems
  };
}

function formatInventorySummaryText(summary, sourceLabel = null) {
  const lines = ['[Inventory Summary]'];

  if (summary.itemCount === 0) {
    lines.push('No inventory items were returned from the feed.');
    if (sourceLabel) lines.push(`Source: ${sourceLabel}`);
    return lines.join('\n');
  }

  lines.push(`Published items: ${summary.itemCount}`);

  if (summary.brandCounts.length) {
    lines.push(`Top brands: ${summary.brandCounts.map(({ name, count }) => `${name} (${count})`).join(', ')}`);
  }

  if (summary.categoryCounts.length) {
    lines.push(`Top categories: ${summary.categoryCounts.map(({ name, count }) => `${name} (${count})`).join(', ')}`);
  }

  if (summary.conditionCounts.length) {
    lines.push(`Conditions: ${summary.conditionCounts.map(({ name, count }) => `${name} (${count})`).join(', ')}`);
  }

  if (summary.priceRange) {
    const money = value => `$${Number(value).toLocaleString('en-US')}`;
    lines.push(`Price range: ${money(summary.priceRange.min)} to ${money(summary.priceRange.max)} (avg ${money(summary.priceRange.avg)})`);
  }

  if (summary.featuredItems.length) {
    lines.push('Featured items:');
    for (const item of summary.featuredItems) {
      const bits = [item.title];
      if (item.condition) bits.push(item.condition);
      if (item.price != null) {
        const priceText = typeof item.price === 'number'
          ? `$${item.price.toLocaleString('en-US')}`
          : String(item.price).trim();
        if (priceText) bits.push(priceText);
      }
      if (item.url) bits.push(item.url);
      lines.push(`- ${bits.join(' — ')}`);
    }
  }

  if (sourceLabel) lines.push(`Source: ${sourceLabel}`);
  return lines.join('\n');
}

// One self-contained text block per item, optimized for RAG retrieval.
function formatItemForEmbedding(item, priceLabel) {
  const lines = [];
  const title = itemTitle(item);
  lines.push(`[Inventory: ${title}]`);
  lines.push('');
  if (item.brand) lines.push(`Brand: ${item.brand}`);
  if (item.productName) lines.push(`Product: ${item.productName}`);
  if (item.modelName) lines.push(`Model: ${item.modelName}`);
  if (item.modelNumber) lines.push(`Model number: ${item.modelNumber}`);
  if (item.productCategoryType && item.productCategoryType !== 'N/A') lines.push(`Category: ${item.productCategoryType}`);
  if (item.usage) lines.push(`Condition: ${item.usage}`);
  if (item.availability) lines.push(`Availability: ${item.availability}`);
  if (item.quantity != null) lines.push(`Quantity in stock: ${item.quantity}`);
  if (item.modelMSRPDisplay) lines.push(`MSRP: ${item.modelMSRPDisplay}`);
  if (item.priceCashDisplay) lines.push(`${priceLabel || 'Price'}: ${item.priceCashDisplay}`);
  if (item.monthlyPaymentDisplay) lines.push(`Monthly payment: ${item.monthlyPaymentDisplay}`);
  if (item.stockCode) lines.push(`Stock #: ${item.stockCode}`);
  if (item.serialNumber) lines.push(`Serial #: ${item.serialNumber}`);
  if (item.engineVendor && item.engineVendor !== 'N/A') lines.push(`Engine: ${item.engineVendor}`);
  if (item.horsepower && item.horsepower !== 'N/A') lines.push(`Horsepower: ${item.horsepower}`);
  if (item.cuttingWidth && item.cuttingWidth !== 'N/A') lines.push(`Cutting width: ${item.cuttingWidth}`);
  if (item.deckSize) lines.push(`Deck size: ${item.deckSize} in`);
  if (item.location) lines.push(`Location: ${item.location}`);
  if (item.dealerComments) lines.push(`Notes: ${item.dealerComments}`);
  return lines.join('\n');
}

function toInventoryRow(locationId, item, url) {
  return {
    location_id: locationId,
    source_item_id: item.id,
    url,
    brand: item.brand || null,
    product_name: item.productName || null,
    model_name: item.modelName || null,
    model_number: item.modelNumber || null,
    stock_code: item.stockCode || null,
    serial_number: item.serialNumber || null,
    usage: item.usage || null,
    availability: item.availability || null,
    quantity: item.quantity ?? null,
    msrp: item.modelMSRP ?? null,
    price_cash: item.priceCash ?? null,
    monthly_payment: item.monthlyPayment ?? null,
    category: item.productCategoryType || null,
    engine_vendor: item.engineVendor === 'N/A' ? null : item.engineVendor,
    horsepower: item.horsepower === 'N/A' ? null : item.horsepower,
    cutting_width: item.cuttingWidth === 'N/A' ? null : item.cuttingWidth,
    deck_size: item.deckSize ?? null,
    dealer_comments: item.dealerComments || null,
    item_location: item.location || null,
    image_url: item.imageUrl || null,
    raw: item,
    scraped_at: new Date().toISOString()
  };
}

module.exports = {
  extractInventoryConfig,
  fetchDealerInventory,
  buildItemUrl,
  itemTitle,
  formatItemForEmbedding,
  toInventoryRow,
  summarizeInventory,
  formatInventorySummaryText
};
