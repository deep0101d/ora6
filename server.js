// server.js
// Express backend using Google Gemini 1.5 Pro for EDU AI Lab
// Endpoints:
//   POST /ask      -> generic AI answer (chat, quiz, flashcards, mindmap, motivation, translation, etc.)
//   POST /plan     -> study plan
//   POST /upload   -> summarize an uploaded file (PDF/DOCX/TXT)

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ===== CONFIG =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

// ⛔ Direct API key here (no dotenv)
const GEMINI_API_KEY = "AIzaSyCwSIJA62axl23pdvoVrZBiesZ7HRRwHRQ"; 
if (!GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY. Set it in server.js.');
  process.exit(1);
}

// ===== APP INIT =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Gemini init
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

// ===== HELPERS =====
async function askGemini(prompt, temperature = 0.7) {
  const res = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature },
  });
  const out = res?.response?.text?.() || '';
  return out.trim();
}

function buildLongSummaryPrompt(text, lang = 'English') {
  return `
You are an academic summarizer. Create a **deep, structured, and readable** summary in ${lang}.
Follow this exact layout (use headings):

Title: (infer if missing)

Executive Summary (6–10 sentences):
- What it is about
- Why it matters
- Context and scope
- Main results or conclusions

Key Concepts (bulleted, concise definitions)

Step-by-Step Explanation (numbered, 8–14 steps):
- Explain the flow or argument in order

Examples & Analogies (2–4 short examples)

Important Data/Formulae:
- (list any numbers, equations, named methods)

Assumptions & Limitations (3–6 bullets)

Implications & Applications (3–6 bullets)

Common Pitfalls / Misconceptions (3–6 bullets)

🎯 10 High-Impact Takeaways (exactly 10 bullets, crisp)

Now summarize this source content:

${text}
`;
}

function buildQuizPrompt(text, count = 10) {
  return `
Create ${count} multiple-choice questions based on the content below.
Rules:
- Each question must test meaningful understanding (not trivia).
- 4 options (A–D).
- Only one correct answer.
- Vary difficulty (mix of recall, inference, application).
- After the options, give "Answer: <Letter>" and a one-line explanation.

Return in this exact format:

1) Question text
A) ...
B) ...
C) ...
D) ...
Answer: <Letter> — short reason

(Content starts)
${text}
`;
}

function buildFlashcardsPrompt(text, count = 20) {
  return `
Generate ${count} high-quality active-recall flashcards from the content.
Return as lines in this format:
Q: <question>
A: <answer>

Keep each Q/A crisp but complete.

CONTENT:
${text}
`;
}

function buildMindmapPrompt(topicOrText) {
  return `
Convert the following content into a Mermaid mind map. 
Return ONLY Mermaid code, starting with "mindmap". 
Use 3–4 levels deep where relevant. Keep node text short.

CONTENT:
${topicOrText}
`;
}

function buildMotivationPrompt(context) {
  return `
Give an energetic, 120–180 word motivational note for a student preparing for exams.
Tone: supportive, focused, practical (1 actionable tip).
Context (optional): ${context || 'N/A'}
`;
}

function buildBilingualWrap(answer, targetLanguage) {
  if (!targetLanguage || targetLanguage.toLowerCase() === 'none') return answer;
  return `${answer}\n\n---\n\n🔁 ${targetLanguage} Translation:\nPlease translate the entire answer above into ${targetLanguage}, keeping structure, headings, lists and tone.`;
}

// ===== ROUTES =====

// Generic ASK
app.post('/ask', async (req, res) => {
  try {
    const { question, mode, language } = req.body || {};
    let prompt = '';

    if (mode === 'summary') {
      prompt = buildLongSummaryPrompt(question, 'English');
    } else if (mode === 'quiz') {
      prompt = buildQuizPrompt(question, 10);
    } else if (mode === 'flashcards') {
      prompt = buildFlashcardsPrompt(question, 24);
    } else if (mode === 'mindmap') {
      prompt = buildMindmapPrompt(question);
    } else if (mode === 'motivation') {
      prompt = buildMotivationPrompt(question);
    } else {
      prompt = question || '';
    }

    let ai = await askGemini(prompt, 0.7);
    ai = buildBilingualWrap(ai, language);

    res.json({ answer: ai });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ask_failed', details: String(err) });
  }
});

// Study Plan
app.post('/plan', async (req, res) => {
  try {
    const { subjects = [], examDate, hoursPerDay = 2, language } = req.body || {};
    const prompt = `
Create a day-by-day study plan until the exam date.
- Subjects: ${subjects.join(', ') || 'N/A'}
- Exam Date: ${examDate}
- Hours/Day: ${hoursPerDay}

Format:
Title, Days Remaining, then a daily schedule (Date: topics, tasks, checkpoints).
Include weekly review slots, spaced repetition pointers, and 3 tips for exam week.
`;

    let ai = await askGemini(prompt, 0.5);
    ai = buildBilingualWrap(ai, language);
    res.json({ plan: ai });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'plan_failed', details: String(err) });
  }
});

// Upload Summarizer
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12 MB
});

async function readTxt(fp) {
  return fs.promises.readFile(fp, 'utf-8');
}
async function readPdf(fp) {
  const dataBuffer = await fs.promises.readFile(fp); // ✅ fixed
  const data = await pdfParse(dataBuffer);
  return data.text || '';
}
async function readDocx(fp) {
  const res = await mammoth.extractRawText({ path: fp });
  return res.value || '';
}

app.post('/upload', upload.single('file'), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'no_file' });

  try {
    let text = '';
    const ext = (f.originalname.split('.').pop() || '').toLowerCase();

    if (ext === 'pdf') text = await readPdf(f.path);
    else if (ext === 'docx') text = await readDocx(f.path);
    else if (ext === 'txt') text = await readTxt(f.path);
    else {
      return res.status(400).json({ error: 'unsupported_type', hint: 'Use PDF, DOCX, or TXT' });
    }

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

// Health
app.get('/', (_req, res) => res.send('✅ EDU AI Lab backend is running.'));

app.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));
