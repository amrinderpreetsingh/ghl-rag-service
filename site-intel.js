const axios = require('axios');
const { URL } = require('url');

const IMPORTANT_PAGE_RULES = [
  { label: 'Inventory', patterns: [/inventory/, /products?/, /catalog/, /showroom/, /shop/, /vehicles?/], score: 12 },
  { label: 'Contact', patterns: [/contact/, /location/, /locations?/, /find-us/, /directions/, /hours?/], score: 11 },
  { label: 'About', patterns: [/about/, /our-story/, /who-we-are/, /company/], score: 10 },
  { label: 'Services', patterns: [/services?/, /service-center/, /repairs?/, /maintenance/, /parts?/], score: 10 },
  { label: 'Financing', patterns: [/financ(e|ing)/, /lease/, /credit/], score: 8 },
  { label: 'Brands', patterns: [/brands?/, /manufacturers?/, /partners?/], score: 8 },
  { label: 'FAQ', patterns: [/faq/, /faqs/, /questions/, /help/], score: 7 },
  { label: 'Reviews', patterns: [/reviews?/, /testimonials?/], score: 6 },
  { label: 'Team', patterns: [/team/, /staff/, /people/], score: 6 },
  { label: 'Warranty', patterns: [/warranty/, /guarantee/], score: 6 }
];

const SKIP_EXTENSIONS = /\.(?:pdf|jpe?g|png|gif|svg|webp|css|js|json|xml|zip|rar|mp4|mp3|mov|avi|wav|ico)(?:\?|#|$)/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function safeUrl(value, baseUrl = null) {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    url.hash = '';
    url.search = '';
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return null;
  }
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<\/(p|div|section|article|main|header|aside|li|tr|h[1-6]|table|ul|ol)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? decodeEntities(match[1].trim()) : '';
}

function extractMetaDescription(html) {
  const source = String(html || '');
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["'][^>]*>/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return decodeEntities(match[1].trim());
  }
  return '';
}

function extractOgSiteName(html) {
  const source = String(html || '');
  const patterns = [
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["'][^>]*>/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return decodeEntities(match[1].trim());
  }
  return '';
}

function flattenJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  if (node['@graph']) flattenJsonLd(node['@graph'], out);
  return out;
}

function extractJsonLdRecords(html) {
  const records = [];
  const source = String(html || '');
  const blocks = [...source.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  for (const block of blocks) {
    const raw = block[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      flattenJsonLd(parsed, records);
    } catch {
      continue;
    }
  }

  return records;
}

function extractBusinessRecord(records) {
  const businessTypes = new Set([
    'organization',
    'localbusiness',
    'store',
    'autodealer',
    'automotivedealer',
    'motorvehicledealer',
    'cardealer',
    'motorcycledealer',
    'business'
  ]);

  for (const record of records) {
    const typeValue = record['@type'];
    const types = Array.isArray(typeValue) ? typeValue : [typeValue];
    const lowered = types.filter(Boolean).map(value => String(value).toLowerCase());
    if (lowered.some(value => businessTypes.has(value))) return record;
  }

  return records.find(record => record.name || record.telephone || record.address) || null;
}

function formatAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();
  const parts = [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    address.addressCountry
  ].filter(Boolean);
  return parts.join(', ');
}

function formatHours(hours) {
  if (!hours) return '';
  const entries = Array.isArray(hours) ? hours : [hours];
  const parts = [];

  for (const entry of entries) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      parts.push(entry);
      continue;
    }

    const day = entry.dayOfWeek
      ? (Array.isArray(entry.dayOfWeek) ? entry.dayOfWeek : [entry.dayOfWeek]).map(value => String(value).replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, '')).join(', ')
      : '';
    const opens = entry.opens || entry.openingHours || '';
    const closes = entry.closes || '';
    if (day && (opens || closes)) {
      parts.push(`${day}: ${opens || '?'}${closes ? `-${closes}` : ''}`);
    } else if (day) {
      parts.push(day);
    }
  }

  return parts.join('; ');
}

function extractPhones(source) {
  const values = new Set();
  const text = String(source || '');

  for (const match of text.matchAll(/tel:([^"'?\s<]+)/gi)) {
    values.add(match[1].trim());
  }

  for (const match of text.matchAll(PHONE_RE)) {
    values.add(match[0].trim());
  }

  return [...values];
}

function extractEmails(source) {
  const values = new Set();
  const text = String(source || '');

  for (const match of text.matchAll(/mailto:([^"'?\s<]+)/gi)) {
    values.add(match[1].trim());
  }

  for (const match of text.matchAll(EMAIL_RE)) {
    values.add(match[0].trim());
  }

  return [...values];
}

function extractSocialLinks(html) {
  const text = String(html || '');
  const socialDomains = [
    'facebook.com',
    'instagram.com',
    'x.com',
    'twitter.com',
    'linkedin.com',
    'youtube.com',
    'tiktok.com'
  ];

  const links = new Set();
  for (const match of text.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = match[1];
    if (!socialDomains.some(domain => href.includes(domain))) continue;
    const url = safeUrl(href);
    if (url) links.add(url);
  }

  const records = extractJsonLdRecords(text);
  const business = extractBusinessRecord(records);
  const sameAs = business?.sameAs;
  const sameAsLinks = Array.isArray(sameAs) ? sameAs : (sameAs ? [sameAs] : []);

  for (const link of sameAsLinks) {
    const url = safeUrl(link);
    if (url) links.add(url);
  }

  return [...links];
}

function extractPathTitle(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    const last = path.split('/').filter(Boolean).pop() || '';
    return last.replace(/[-_]+/g, ' ').trim();
  } catch {
    return '';
  }
}

function deriveBusinessName(title = '', siteName = '', fallback = '') {
  const candidates = [siteName, title, fallback];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const parts = value
      .split(/\s*[|•·\-–—]\s*/)
      .map(part => part.trim())
      .filter(Boolean)
      .filter(part => !/^(home|about|contact|inventory|products?|services?|faq|blog|reviews?)$/i.test(part));
    if (parts.length) return parts[parts.length - 1];
    if (!/^(home|about|contact|inventory|products?|services?|faq|blog|reviews?|welcome)$/i.test(value) && value.length > 2) return value;
  }
  return '';
}

function classifyPage(url, title, text) {
  const haystack = `${url} ${title} ${text.slice(0, 500)}`.toLowerCase();
  for (const rule of IMPORTANT_PAGE_RULES) {
    if (rule.patterns.some(pattern => pattern.test(haystack))) {
      return rule.label;
    }
  }
  return '';
}

function scorePage(url, title, text) {
  const haystack = `${url} ${title} ${text.slice(0, 500)}`.toLowerCase();
  let score = 0;
  for (const rule of IMPORTANT_PAGE_RULES) {
    if (rule.patterns.some(pattern => pattern.test(haystack))) score += rule.score;
  }

  try {
    const parsedUrl = new URL(url);
    const pathDepth = parsedUrl.pathname.split('/').filter(Boolean).length;
    score += Math.max(0, 4 - pathDepth);
    if (parsedUrl.pathname === '/' || url.endsWith('#home')) score += 20;
  } catch {
    // ignore
  }
  if (text && text.length < 500) score += 1;
  return score;
}

function extractFirstParagraph(text) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map(line => line.trim())
    .filter(Boolean);
  return paragraphs.find(paragraph => paragraph.length > 60) || paragraphs[0] || '';
}

function normalizePage(page, startUrl) {
  const url = safeUrl(page.url || page.metadata?.sourceURL || startUrl, startUrl);
  const rawHtml = page.rawHtml || page.html || '';
  const markdown = page.markdown || page.text || '';
  const title = page.title || page.pageTitle || page.metadata?.title || extractTitle(rawHtml) || extractPathTitle(url || startUrl);
  const text = markdown || stripHtml(rawHtml);
  return {
    url: url || safeUrl(startUrl),
    title,
    rawHtml,
    markdown: text,
    text,
    metadata: page.metadata || {},
    source: page.source || 'crawl'
  };
}

function collectSiteFacts(pages, startUrl) {
  const facts = {
    businessName: '',
    description: '',
    phones: new Set(),
    emails: new Set(),
    addresses: new Set(),
    hours: new Set(),
    socialLinks: new Set(),
    pageHighlights: []
  };

  const normalizedPages = pages.map(page => normalizePage(page, startUrl));
  const homePage = normalizedPages.find(page => {
    try {
      return page.url && new URL(page.url).pathname === '/';
    } catch {
      return false;
    }
  }) || normalizedPages[0];

  for (const page of normalizedPages) {
    const html = page.rawHtml || '';
    const text = page.text || '';
    const title = page.title || '';
    const records = extractJsonLdRecords(html);
    const business = extractBusinessRecord(records);

    if (!facts.businessName) {
      const derived = deriveBusinessName(
        business?.name || title,
        extractOgSiteName(html),
        extractPathTitle(page.url || '')
      );
      if (derived) facts.businessName = derived;
    }

    if (!facts.description) {
      const description = business?.description || extractMetaDescription(html) || extractFirstParagraph(text);
      if (description) facts.description = description.trim();
    }

    for (const phone of [
      ...(business?.telephone ? [business.telephone] : []),
      ...extractPhones(html),
      ...extractPhones(text)
    ]) {
      const value = String(phone || '').trim();
      if (value) facts.phones.add(value);
    }

    for (const email of [
      ...(business?.email ? [business.email] : []),
      ...extractEmails(html),
      ...extractEmails(text)
    ]) {
      const value = String(email || '').trim();
      if (value) facts.emails.add(value);
    }

    const addressSources = [];
    if (business?.address) addressSources.push(business.address);
    if (business?.location) addressSources.push(business.location);
    if (business?.contactPoint?.address) addressSources.push(business.contactPoint.address);
    for (const address of addressSources) {
      const formatted = formatAddress(address);
      if (formatted) facts.addresses.add(formatted);
    }

    const hours = formatHours(business?.openingHoursSpecification || business?.openingHours);
    if (hours) facts.hours.add(hours);

    for (const link of extractSocialLinks(html)) {
      facts.socialLinks.add(link);
    }

    const category = classifyPage(page.url || startUrl, title, text);
    const score = scorePage(page.url || startUrl, title, text);
    if (category || score >= 8) {
      facts.pageHighlights.push({
        category: category || 'Important page',
        title,
        url: page.url || startUrl,
        score
      });
    }
  }

  if (!facts.businessName && homePage) {
    facts.businessName = deriveBusinessName(homePage.title, extractOgSiteName(homePage.rawHtml), extractPathTitle(homePage.url || ''));
  }

  if (!facts.description && homePage) {
    facts.description = extractMetaDescription(homePage.rawHtml) || extractFirstParagraph(homePage.text) || '';
  }

  facts.phones = [...facts.phones];
  facts.emails = [...facts.emails];
  facts.addresses = [...facts.addresses];
  facts.hours = [...facts.hours];
  facts.socialLinks = [...facts.socialLinks];

  facts.pageHighlights = facts.pageHighlights
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 8)
    .map(({ score, ...rest }) => rest);

  return facts;
}

function renderCountList(entries, limit = 5) {
  return entries
    .slice(0, limit)
    .map(({ name, count }) => `${name} (${count})`)
    .join(', ');
}

function buildClientProfileText({ startUrl, businessName, facts, pageCount, supplementalCount, inventorySummary }) {
  const lines = [`[Client Profile: ${businessName || extractPathTitle(startUrl) || new URL(startUrl).hostname}]`];
  lines.push(`Website: ${startUrl}`);
  lines.push(`Crawl coverage: ${pageCount} site pages${supplementalCount ? ` + ${supplementalCount} supplemental pages` : ''}`);

  if (facts.description) {
    lines.push(`What they do: ${facts.description.slice(0, 400)}`);
  }

  if (facts.phones?.length) {
    lines.push(`Phone: ${facts.phones[0]}`);
  }

  if (facts.emails?.length) {
    lines.push(`Email: ${facts.emails[0]}`);
  }

  if (facts.addresses?.length) {
    lines.push(`Address: ${facts.addresses[0]}`);
  }

  if (facts.hours?.length) {
    lines.push(`Hours: ${facts.hours[0]}`);
  }

  if (facts.socialLinks?.length) {
    lines.push(`Social: ${facts.socialLinks.slice(0, 3).join(', ')}`);
  }

  if (facts.pageHighlights?.length) {
    lines.push('Important pages:');
    for (const page of facts.pageHighlights.slice(0, 6)) {
      lines.push(`- ${page.category}: ${page.title} — ${page.url}`);
    }
  }

  if (inventorySummary) {
    lines.push(`Inventory snapshot: ${inventorySummary.itemCount} items`);
    if (inventorySummary.brandCounts?.length) {
      lines.push(`Top brands: ${renderCountList(inventorySummary.brandCounts, 4)}`);
    }
    if (inventorySummary.categoryCounts?.length) {
      lines.push(`Top categories: ${renderCountList(inventorySummary.categoryCounts, 4)}`);
    }
    if (inventorySummary.priceRange) {
      const formatMoney = value => `$${Number(value).toLocaleString('en-US')}`;
      lines.push(`Price range: ${formatMoney(inventorySummary.priceRange.min)} to ${formatMoney(inventorySummary.priceRange.max)}`);
    }
  }

  return lines.join('\n');
}

async function fetchTextPage(url) {
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

function extractLinks(html, baseUrl) {
  const links = new Set();
  const source = String(html || '');

  for (const match of source.matchAll(/href=["']([^"'#]+)["']/gi)) {
    const href = match[1].trim();
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    const url = safeUrl(href, baseUrl);
    if (!url) continue;
    if (SKIP_EXTENSIONS.test(url)) continue;
    if (!sameOrigin(url, baseUrl)) continue;
    links.add(url);
  }

  return [...links];
}

function scoreUrl(url) {
  const haystack = url.toLowerCase();
  let score = 0;
  for (const rule of IMPORTANT_PAGE_RULES) {
    if (rule.patterns.some(pattern => pattern.test(haystack))) score += rule.score;
  }

  try {
    const pathDepth = new URL(url).pathname.split('/').filter(Boolean).length;
    score += Math.max(0, 4 - pathDepth);
  } catch {
    // ignore
  }

  return score;
}

async function extractSitemapUrls(origin) {
  const urls = new Set();
  const seenSitemaps = new Set();

  async function loadSitemap(sitemapUrl, depth = 0) {
    const canonical = safeUrl(sitemapUrl);
    if (!canonical || seenSitemaps.has(canonical) || depth > 2) return;
    seenSitemaps.add(canonical);

    let text;
    try {
      text = await fetchTextPage(canonical);
    } catch {
      return;
    }

    const locs = [...text.matchAll(/<loc>(.*?)<\/loc>/gi)].map(match => match[1].trim()).filter(Boolean);
    if (!locs.length) return;

    if (/<sitemapindex[\s>]/i.test(text)) {
      for (const loc of locs.slice(0, 50)) {
        await loadSitemap(loc, depth + 1);
      }
      return;
    }

    for (const loc of locs) {
      const url = safeUrl(loc);
      if (url && sameOrigin(url, origin) && !SKIP_EXTENSIONS.test(url)) {
        urls.add(url);
      }
    }
  }

  const robotsCandidates = [];
  try {
    const robots = await fetchTextPage(`${origin}/robots.txt`);
    for (const line of robots.split(/\r?\n/)) {
      const match = line.match(/^\s*sitemap:\s*(.+)\s*$/i);
      if (match) robotsCandidates.push(match[1].trim());
    }
  } catch {
    // ignore
  }

  if (!robotsCandidates.length) {
    robotsCandidates.push(`${origin}/sitemap.xml`);
  }

  for (const sitemapUrl of robotsCandidates) {
    await loadSitemap(sitemapUrl);
  }

  return [...urls];
}

async function discoverSupplementalUrls(startUrl, crawledUrls = [], limit = 10) {
  const origin = new URL(startUrl).origin;
  const candidates = new Set();
  const crawled = new Set(crawledUrls.map(url => safeUrl(url)).filter(Boolean));

  try {
    const homeHtml = await fetchTextPage(startUrl);
    for (const link of extractLinks(homeHtml, startUrl)) {
      candidates.add(link);
    }
  } catch {
    // ignore
  }

  try {
    const sitemapUrls = await extractSitemapUrls(origin);
    for (const url of sitemapUrls) {
      candidates.add(url);
    }
  } catch {
    // ignore
  }

  return [...candidates]
    .filter(url => url && sameOrigin(url, origin))
    .filter(url => !crawled.has(url))
    .filter(url => url !== safeUrl(startUrl))
    .filter(url => !SKIP_EXTENSIONS.test(url))
    .map(url => ({
      url,
      score: scoreUrl(url)
    }))
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, limit)
    .map(entry => entry.url);
}

function shouldChunkPage(url, title, text) {
  const content = `${url} ${title} ${text}`.toLowerCase();
  const important = IMPORTANT_PAGE_RULES.some(rule => rule.patterns.some(pattern => pattern.test(content)));
  return important || String(text || '').trim().split(/\s+/).length >= 30;
}

module.exports = {
  safeUrl,
  stripHtml,
  extractTitle,
  extractMetaDescription,
  collectSiteFacts,
  buildClientProfileText,
  discoverSupplementalUrls,
  shouldChunkPage,
  htmlToText: stripHtml,
  extractBusinessRecord,
  extractJsonLdRecords
};
