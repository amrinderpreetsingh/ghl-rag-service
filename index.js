require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SECRET = process.env.RAG_SECRET;

// Auth middleware
function auth(req, res, next) {
  if (!SECRET || req.headers['x-rag-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Routes
const scrapeRouter = require('./routes/scrape');
const searchRouter = require('./routes/search');
const jobsRouter = require('./routes/jobs');

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.use('/scrape', auth, scrapeRouter);
app.use('/search', auth, searchRouter);
app.use('/jobs', auth, jobsRouter);

app.listen(PORT, () => {
  console.log(`[rag-service] Running on port ${PORT}`);
});
