// server.js
// EDU AI Lab backend with Gemini 2.5 Pro (No dotenv)

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// 🔑 Put your API key here
const GEMINI_API_KEY = 'AIzaSyCwSIJA62axl23pdvoVrZBiesZ7HRRwHRQ';
if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Gemini init (using 2.5 Pro)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

// Helper to send prompt to Gemini
async function askGemini(prompt, temperature = 0.7) {
  const res = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature },
  });
  const out = res?.response?.text?.() || '';
  return out.trim();
}

// Build prompts
function buildLongSummaryPrompt(text, lang = 'English') {
  return `
You are an academic summarizer. Create a deep, structured, and readable summary in ${lang}.

Title: (infer if missing)
Executive Summary
Key Concepts
Step-by-Step Explanation
Examples & Analogies
Important Data/Formulae
Assumptions & Limitations
Implications & Applications
Common Pitfalls / Misconceptions
🎯 10 High-Impact Takeaways

Now summarize this source content:

${text}
`;
}

function buildQuizPrompt(text, count = 10) {
  return `
Create ${count} multiple-choice questions from the content below.
4 options (A–D), only one correct.
Show "Answer: <Letter> — reason".

${text}
`;
}

function buildFlashcardsPrompt(text, count = 20) {
  return `
Generate ${count} active-recall flashcards.
Q: <question>
A: <answer>

CONTENT:
${text}
`;
}

function buildMindmapPrompt(topicOrText) {
  return `
Convert into a Mermaid mind map.
Return ONLY Mermaid code starting with "mindmap".

${topicOrText}
`;
}

function buildMotivationPrompt(context) {
  return `
Give a 150-word motivational note for exam prep.
Include one actionable tip.
Context: ${context || 'N/A'}
`;
}

function buildBilingualWrap(answer, targetLanguage) {
  if (!targetLanguage || targetLanguage.toLowerCase() === 'none') return answer;
  return `${answer}\n\n---\n\n🔁 ${targetLanguage} Translation:\nPlease translate the entire answer above into ${targetLanguage}.`;
}

// ===== Routes =====

// Generic ask endpoint
app.post('/ask', async (req, res) => {
  try {
    const { question, mode, language } = req.body || {};
    let prompt = '';

    if (mode === 'summary') prompt = buildLongSummaryPrompt(question, 'English');
    else if (mode === 'quiz') prompt = buildQuizPrompt(question, 10);
    else if (mode === 'flashcards') prompt = buildFlashcardsPrompt(question, 24);
    else if (mode === 'mindmap') prompt = buildMindmapPrompt(question);
    else if (mode === 'motivation') prompt = buildMotivationPrompt(question);
    else prompt = question || '';

    let ai = await askGemini(prompt, 0.7);
    ai = buildBilingualWrap(ai, language);

    res.json({ answer: ai });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ask_failed', details: String(err) });
  }
});

// Study plan endpoint
app.post('/plan', async (req, res) => {
  try {
    const { subjects = [], examDate, hoursPerDay = 2, language } = req.body || {};
    const prompt = `
Create a day-by-day study plan until ${examDate}.
Subjects: ${subjects.join(', ') || 'N/A'}
Hours/Day: ${hoursPerDay}
Include weekly reviews, spaced repetition, and 3 exam week tips.
`;

    let ai = await askGemini(prompt, 0.5);
    ai = buildBilingualWrap(ai, language);
    res.json({ plan: ai });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'plan_failed', details: String(err) });
  }
});

// File upload summarizer
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 12 * 1024 * 1024 },
});

async function readTxt(fp) { return fs.promises.readFile(fp, 'utf-8'); }
async function readPdf(fp) { const data = await pdf(await fs.promises.readFile(fp)); return data.text || ''; }
async function readDocx(fp) { const res = await mammoth.extractRawText({ path: fp }); return res.value || ''; }

app.post('/upload', upload.single('file'), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'no_file' });

  try {
    let text = '';
    const ext = (f.originalname.split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') text = await readPdf(f.path);
    else if (ext === 'docx') text = await readDocx(f.path);
    else if (ext === 'txt') text = await readTxt(f.path);
    else return res.status(400).json({ error: 'unsupported_type' });

    if (!text.trim()) return res.status(400).json({ error: 'empty_file' });

    const prompt = buildLongSummaryPrompt(text, 'English');
    let summary = await askGemini(prompt, 0.4);
    summary = buildBilingualWrap(summary, req.body?.language);

    res.json({ summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'upload_failed', details: String(err) });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }
});

// Health check
app.get('/', (_req, res) => res.send('✅ EDU AI Lab backend is running (Gemini 2.5 Pro)'));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
