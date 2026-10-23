// 1. INSERISCI QUI LA TUA API KEY DI GEMINI
const API_KEY = "";

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "gemini_words_daily.json");

const now = new Date();
const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

// Quante parole chiedere a Gemini e quante tenerne dopo il filtro locale
const REQUEST_COUNT = 15;
const WORDS_PER_DAY = 10;

// Una parola già uscita non ritorna prima di questo periodo (60 giorni)
const COOLDOWN_MS = 60 * 24 * 60 * 60 * 1000;

// 2. Lettura dello stato salvato in memoria
let state = {
  date: "",
  currentIndex: 0,
  words: [],
  seen: {}   // parola (minuscola) -> timestamp dell'ultima volta che è uscita
};

if (fm.fileExists(cachePath)) {
  try {
    const rawData = fm.readString(cachePath);
    state = { ...state, ...JSON.parse(rawData) };
  } catch (e) {
    console.log("Errore lettura cache, la ricreo.");
  }
}

if (!state.seen) state.seen = {};

// Migrazione dal vecchio formato (state.history) al nuovo (state.seen)
if (state.history) {
  for (const w of state.history) state.seen[norm(w)] = Date.now();
  delete state.history;
}

function norm(w) {
  return String(w).trim().toLowerCase();
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function saveState() {
  fm.writeString(cachePath, JSON.stringify(state));
}

// Temi scelti a caso ad ogni richiesta, in inglese (il prompt è in inglese,
// più efficace per ottenere vocabolario inglese reale).
const THEMES = [
  "emotions and mental states", "nature and landscapes", "business and economics",
  "science and technology", "art and creativity", "human relationships",
  "food and taste", "travel and places", "time and change", "the body and movement"
];

// Registri scelti a caso ad ogni richiesta: spezzano le "parole preferite" del modello
const REGISTERS = [
  "a phrasal verb", "an idiom or fixed expression", "an adjective", "a verb",
  "a noun", "an adverb", "an informal word used in everyday speech"
];

// Parole uscite di recente (entro il cooldown), più recenti prima, max 100
function recentWords() {
  const cutoff = Date.now() - COOLDOWN_MS;
  return Object.keys(state.seen)
    .filter(k => state.seen[k] >= cutoff)
    .sort((a, b) => state.seen[b] - state.seen[a])
    .slice(0, 100);
}

function isRecent(word) {
  const last = state.seen[norm(word)];
  return last !== undefined && Date.now() - last < COOLDOWN_MS;
}

// Rimuove dal file le parole più vecchie del cooldown
function pruneSeen() {
  const cutoff = Date.now() - COOLDOWN_MS;
  for (const key of Object.keys(state.seen)) {
    if (state.seen[key] < cutoff) delete state.seen[key];
  }
}

// 3. Chiamata a Gemini: restituisce una lista di parole grezza
async function askGemini(theme, register) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${API_KEY}`;

  const avoid = recentWords();
  const exclusionText = avoid.length > 0
    ? `Do not include any of these words, already used recently: ${avoid.join(", ")}.`
    : "";

  const promptText = `
  You are helping a native Italian speaker genuinely expand their English vocabulary.

  Generate a list of ${REQUEST_COUNT} English words related to the theme "${theme}".
  Prefer words that are ${register}.

  Requirements:
  - Do NOT pick basic/elementary words that a beginner already knows (e.g. "cat", "dog", "table", "happy", "big").
  - Do NOT pick words of clear Latin/Romance origin that are close cognates of Italian, since an Italian speaker
    can usually guess those instantly (e.g. avoid words like "elegant", "curious", "necessary" — too close to
    Italian equivalents). Prefer words of Germanic/Anglo-Saxon origin, idiomatic words, phrasal verbs, or
    words whose meaning or usage is genuinely not obvious to an Italian speaker.
  - The goal is real vocabulary learning, not just "fancy sounding" words. Prioritize usefulness and
    everyday/professional applicability over sounding elegant or literary.
  - Pick words a proficient (not native) English speaker would find useful to actively know, roughly
    B2-C1 level.
  ${exclusionText}

  Respond ONLY with a valid JSON array of ${REQUEST_COUNT} objects (no markdown, no extra text) with this structure:
  [
    {
      "word": "word",
      "partOfSpeech": "(adjective/noun/verb/etc.)",
      "definition": "definition in English",
      "example": "example sentence in English"
    }
  ]
  `;

  const req = new Request(url);
  req.method = "POST";
  req.headers = { "Content-Type": "application/json" };
  req.body = JSON.stringify({
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 1.5,   // più alto = scelte più varie (max 2.0), ma parole più rumorose
      topP: 0.97,
      topK: 64
    }
  });

  const res = await req.loadJSON();
  const parts = (res.candidates && res.candidates[0] && res.candidates[0].content
    && res.candidates[0].content.parts) || [];
  const text = parts[0] && parts[0].text;
  if (!text) {
    throw new Error("Risposta non valida da Gemini: " + JSON.stringify(res).slice(0, 300));
  }

  // Tiene solo gli oggetti con i campi minimi, così il widget non mostra "Word" vuoti
  return JSON.parse(text).filter(w => w && w.word && w.definition);
}

// 4. Filtro locale: niente parole recenti, niente doppioni. Al massimo 2 tentativi.
async function fetchWords() {
  const picked = [];
  const keysInBatch = new Set();

  for (let attempt = 0; attempt < 2 && picked.length < WORDS_PER_DAY; attempt++) {
    const candidates = await askGemini(pick(THEMES), pick(REGISTERS));

    for (const w of candidates) {
      const key = norm(w.word);
      if (isRecent(w.word) || keysInBatch.has(key)) continue;
      keysInBatch.add(key);
      picked.push(w);
      if (picked.length === WORDS_PER_DAY) break;
    }
  }

  if (picked.length === 0) throw new Error("Gemini non ha restituito parole nuove.");
  return picked;
}

// 5. Se cambia il giorno o la cache è vuota, scarica parole nuove.
// NESSUN fallback silenzioso: se fallisce, l'errore viene mostrato per intero.
let needsFetch = state.date !== todayStr || !state.words || state.words.length === 0;
let fetchError = null;

if (needsFetch) {
  try {
    state.words = await fetchWords();
    state.date = todayStr;
    state.currentIndex = 0;

    const stamp = Date.now();
    for (const w of state.words) state.seen[norm(w.word)] = stamp;
    pruneSeen();

    saveState();
  } catch (e) {
    fetchError = e;
    console.log("Errore API Gemini: " + e);
  }
}

// Se non abbiamo parole utilizzabili, mostriamo l'errore ed usciamo.
if (fetchError || !state.words || state.words.length === 0) {
  if (config.runsInWidget) {
    const errWidget = new ListWidget();
    errWidget.backgroundColor = new Color("#1c1c1e");
    errWidget.setPadding(16, 16, 16, 16);
    const t = errWidget.addText("Errore Gemini");
    t.textColor = new Color("#ff453a");
    t.font = Font.boldSystemFont(14);
    errWidget.addSpacer(6);
    const m = errWidget.addText(fetchError ? String(fetchError) : "Nessuna parola disponibile.");
    m.textColor = new Color("#d1d1d6");
    m.font = Font.systemFont(11);
    Script.setWidget(errWidget);
  } else {
    const err = new Alert();
    err.title = "Errore Gemini";
    err.message = fetchError ? String(fetchError) : "Nessuna parola disponibile.";
    err.addAction("OK");
    await err.presentAlert();
    App.close();
  }
  Script.complete();
}

// 6. Selezione della parola corrente (quella mostrata nel widget al momento del tocco)
if (state.currentIndex >= state.words.length) state.currentIndex = 0;
const wordData = state.words[state.currentIndex] || state.words[0];

// 7. Costruzione grafica del Widget
function buildWidget(data, index, total) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#1c1c1e");
  widget.setPadding(16, 16, 16, 16);

  const headerStack = widget.addStack();
  const titleText = headerStack.addText("DAILY WORD");
  titleText.textColor = new Color("#8e8e93");
  titleText.font = Font.boldSystemFont(10);

  headerStack.addSpacer();

  const countText = headerStack.addText(`${index + 1}/${total}`);
  countText.textColor = new Color("#0a84ff");
  countText.font = Font.boldSystemFont(10);

  widget.addSpacer(6);

  const wordTitle = widget.addText(data.word || "Word");
  wordTitle.textColor = new Color("#ffffff");
  wordTitle.font = Font.boldSystemFont(22);

  if (data.partOfSpeech) {
    const posText = widget.addText(data.partOfSpeech);
    posText.textColor = new Color("#0a84ff");
    posText.font = Font.italicSystemFont(12);
  }

  widget.addSpacer(8);

  const defText = widget.addText(data.definition || "");
  defText.textColor = new Color("#d1d1d6");
  defText.font = Font.systemFont(12);
  defText.lineLimit = 3;

  if (data.example) {
    widget.addSpacer(6);
    const exText = widget.addText(`"${data.example}"`);
    exText.textColor = new Color("#98989d");
    exText.font = Font.italicSystemFont(12);
    exText.lineLimit = 2;
  }

  return widget;
}

// 8. Renderizzazione ed Esecuzione
if (config.runsInWidget) {
  const widget = buildWidget(wordData, state.currentIndex, state.words.length);
  Script.setWidget(widget);

} else {
  // Mostra la parola su cui hai toccato...
  const widget = buildWidget(wordData, state.currentIndex, state.words.length);
  await widget.presentMedium();

  // ...poi chiedi solo se vuoi andare avanti.
  const alert = new Alert();
  alert.title = "Vuoi andare avanti?";
  alert.addAction("➡️ Prossima parola");
  alert.addCancelAction("Chiudi");

  const choice = await alert.presentSheet();

  if (choice === 0) {
    state.currentIndex = (state.currentIndex + 1) % state.words.length;
    saveState();
  }

  App.close();
}
Script.complete();
