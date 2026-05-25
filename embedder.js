const axios = require('axios');

const MODEL = 'voyage-3';
const BATCH_SIZE = 64;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function embedBatch(texts, inputType = 'document') {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(
        'https://api.voyageai.com/v1/embeddings',
        { model: MODEL, input: texts, input_type: inputType },
        {
          headers: {
            'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      return res.data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    } catch (err) {
      const status = err.response?.status;
      if ((status === 429 || status >= 500) && attempt < 3) {
        await sleep(1000 * attempt);
      } else {
        throw new Error(`Voyage AI failed: ${err.response?.data?.detail || err.message}`);
      }
    }
  }
}

async function embedTexts(texts) {
  const all = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await embedBatch(batch, 'document');
    all.push(...embeddings);
    if (i + BATCH_SIZE < texts.length) await sleep(200);
  }
  return all;
}

async function embedQuery(query) {
  const [embedding] = await embedBatch([query], 'query');
  return embedding;
}

module.exports = { embedTexts, embedQuery };
