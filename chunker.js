const TARGET_WORDS = 400;
const OVERLAP_WORDS = 50;
const MIN_WORDS = 30;

function wordCount(text) {
  return text.trim().split(/\s+/).length;
}

function splitIntoParagraphs(text) {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const result = [];
  for (const para of paras) {
    if (wordCount(para) <= TARGET_WORDS * 1.5) {
      result.push(para);
    } else {
      const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
      let current = '';
      for (const s of sentences) {
        if (wordCount(current) + wordCount(s) > TARGET_WORDS && current) {
          result.push(current.trim());
          current = s;
        } else {
          current += ' ' + s;
        }
      }
      if (current.trim()) result.push(current.trim());
    }
  }
  return result;
}

function chunkText(text, pageTitle, url) {
  const paragraphs = splitIntoParagraphs(text);
  const chunks = [];
  let currentWords = [];

  for (const para of paragraphs) {
    const paraWords = para.trim().split(/\s+/);
    if (currentWords.length + paraWords.length > TARGET_WORDS && currentWords.length > 0) {
      const content = currentWords.join(' ');
      if (wordCount(content) >= MIN_WORDS) chunks.push(content);
      currentWords = [...currentWords.slice(-OVERLAP_WORDS), ...paraWords];
    } else {
      currentWords.push(...paraWords);
    }
  }

  if (currentWords.length >= MIN_WORDS) chunks.push(currentWords.join(' '));

  return chunks.map((content, index) => ({
    content: pageTitle ? `[${pageTitle}]\n\n${content}` : content,
    chunkIndex: index,
    url,
    pageTitle: pageTitle || url
  }));
}

module.exports = { chunkText };
