// server.js  — EDU AI Lab backend (CommonJS)
// Endpoints:
//  POST /summarize-text     { text, language? }
//  POST /summarize-pdf      multipart/form-data: file=PDF, language?
//  POST /generate-quiz      { text, count?, language? }
//  POST /flashcards         { text, count?, language? }
//  POST /study-planner      { subjects:[], examDate, hoursPerDay?, language? }
//  POST /mindmap            { text, language? }  -> returns Mermaid code
//  POST /motivation         { context?, language? }
//  GET  /                   health check

import express from "express";
import cors from "cors";
import multer from "multer";
import mammoth from "mammoth";
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as pdfjsLib from "pdfjs-dist/build/pdf.js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ✅ Use env var if present, else paste your key here
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "AIzaSyCwSIJA62axl23pdvoVrZBiesZ7HRRwHRQ";

// ======= Safety checks
if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("PASTE_YOUR_")) {
  console.warn(
    "⚠️  GEMINI_API_KEY not set. Set env var GEMINI_API_KEY or edit server.js."
  );
}

// ======= App setup
const app = express();
const PORT = process.env.PORT || 30001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ======= File uploads
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

// ======= Gemini (2.5 pro)
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

// ======= Helpers
async function askGemini(prompt, temperature = 0.7) {
  const res = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature },
  });
  const txt = res?.response?.text ? res.response.text() : "";
  return (txt || "").trim();
}

function wrapBilingual(text, language) {
  if (!language || /^none$/i.test(language)) return text;
  return `${text}\n\n---\n\n🔁 ${language} Translation:\nTranslate the entire answer above to ${language}, preserving structure, headings, lists and tone.`;
}

function promptSummary(text, lang = "English") {
  return `You are an academic summarizer. Create a deep, structured, readable summary in ${lang}.
Use this layout:

Title: (infer)

Executive Summary (6–10 sentences):
- What it's about
- Why it matters
- Context/scope
- Main results or conclusions

Key Concepts (bulleted, concise)

Step-by-Step Explanation (8–14 numbered steps)

Examples & Analogies (2–4)

Important Data/Formulae (if any)

Assumptions & Limitations (3–6)

Implications & Applications (3–6)

Common Pitfalls / Misconceptions (3–6)

🎯 10 High-Impact Takeaways (exactly 10 bullets)

Source:
${text}`;
}

function promptQuiz(text, count = 10) {
  return `Create ${count} multiple-choice questions from the content below.
Rules:
- Each question should test meaningful understanding.
- 4 options (A–D), one correct answer.
- Mix recall, inference, application.
- After options, give "Answer: <Letter> — one-line reason".

Format exactly:

1) Question text
A) ...
B) ...
C) ...
D) ...
Answer: <Letter> — reason

Content:
${text}`;
}

function promptFlashcards(text, count = 20) {
  return `Generate ${count} high-quality active-recall flashcards from the content.
Return lines exactly as:
Q: <question>
A: <answer>

CONTENT:
${text}`;
}

function promptMindmap(text) {
  return `Convert the following content to Mermaid mind map.
Return ONLY Mermaid code starting with "mindmap".
Use 3–4 levels of depth, short node text.

CONTENT:
${text}`;
}

function promptMotivation(context) {
  return `Write a 120–180 word motivational note for a student preparing for exams.
Tone: supportive, focused, practical (include 1 actionable tip).
Context (optional): ${context || "N/A"}`;
}

// ======= Read files (PDF via pdfjs-dist, DOCX via mammoth, TXT via fs)
async function readTxt(fp) {
  return fs.promises.readFile(fp, "utf-8");
}

async function readDocx(fp) {
  const res = await mammoth.extractRawText({ path: fp });
  return res.value || "";
}

// PDF extraction via pdfjs-dist to avoid pdf-parse test file issue
async function readPdf(fp) {
  const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
  const data = await fs.promises.readFile(fp);
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;

  let out = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items.map((it) => it.str);
    out += strings.join(" ") + "\n\n";
  }
  return out;
}

// ========== ROUTES ==========

// Health
app.get("/", (_req, res) => {
  res.send("✅ EDU AI Lab backend is running.");
});

// 1) Summarize plain text
app.post("/summarize-text", async (req, res) => {
  try {
    const { text, language } = req.body || {};
    if (!text || !text.trim())
      return res.status(400).json({ error: "missing_text" });

    const prompt = promptSummary(text, "English");
    let answer = await askGemini(prompt, 0.5);
    answer = wrapBilingual(answer, language);
    res.json({ summary: answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "summarize_text_failed", details: String(e) });
  }
});

// 2) Summarize PDF (multipart upload)
app.post("/summarize-pdf", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no_file" });
  const { language } = req.body || {};

  try {
    const ext = (path.extname(req.file.originalname) || "").toLowerCase();
    if (ext !== ".pdf")
      return res.status(400).json({ error: "unsupported_type", hint: "Upload a PDF file." });

    const text = await readPdf(req.file.path);
    if (!text.trim()) return res.status(400).json({ error: "empty_pdf" });

    const prompt = promptSummary(text, "English");
    let summary = await askGemini(prompt, 0.4);
    summary = wrapBilingual(summary, language);
    res.json({ summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "summarize_pdf_failed", details: String(e) });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }
});

// 3) Generate Quiz
app.post("/generate-quiz", async (req, res) => {
  try {
    const { text, count = 10, language } = req.body || {};
    if (!text || !text.trim())
      return res.status(400).json({ error: "missing_text" });

    const prompt = promptQuiz(text, Math.max(1, Math.min(+count || 10, 50)));
    let answer = await askGemini(prompt, 0.7);
    answer = wrapBilingual(answer, language);
    res.json({ quiz: answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "quiz_failed", details: String(e) });
  }
});

// 4) Flashcards
app.post("/flashcards", async (req, res) => {
  try {
    const { text, count = 20, language } = req.body || {};
    if (!text || !text.trim())
      return res.status(400).json({ error: "missing_text" });

    const prompt = promptFlashcards(text, Math.max(1, Math.min(+count || 20, 100)));
    let answer = await askGemini(prompt, 0.6);
    answer = wrapBilingual(answer, language);
    res.json({ cards: answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "flashcards_failed", details: String(e) });
  }
});

// 5) Study Planner
app.post("/study-planner", async (req, res) => {
  try {
    const { subjects = [], examDate, hoursPerDay = 2, language } = req.body || {};
    if (!examDate || !subjects.length)
      return res.status(400).json({ error: "missing_fields", hint: "Provide subjects[] and examDate." });

    const prompt = `Create a day-by-day study plan until the exam date.
- Subjects: ${subjects.join(", ")}
- Exam Date: ${examDate}
- Hours/Day: ${hoursPerDay}

Format:
Title, Days Remaining, then a daily schedule (Date: topics, tasks, checkpoints).
Include weekly review slots, spaced repetition pointers, and 3 tips for exam week.`;

    let answer = await askGemini(prompt, 0.5);
    answer = wrapBilingual(answer, language);
    res.json({ plan: answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "planner_failed", details: String(e) });
  }
});

// 6) Mindmap (Mermaid)
app.post("/mindmap", async (req, res) => {
  try {
    const { text, language } = req.body || {};
    if (!text || !text.trim())
      return res.status(400).json({ error: "missing_text" });

    const prompt = promptMindmap(text);
    let code = await askGemini(prompt, 0.5);
    code = wrapBilingual(code, language);
    res.json({ mermaid: code });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "mindmap_failed", details: String(e) });
  }
});

// 7) Motivation
app.post("/motivation", async (req, res) => {
  try {
    const { context, language } = req.body || {};
    const prompt = promptMotivation(context);
    let answer = await askGemini(prompt, 0.8);
    answer = wrapBilingual(answer, language);
    res.json({ message: answer });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "motivation_failed", details: String(e) });
  }
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`✅ EDU AI Lab backend listening on http://localhost:${PORT}`);
});
