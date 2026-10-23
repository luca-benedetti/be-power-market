// 1. INSERISCI QUI LA TUA API KEY DI GEMINI
const API_KEY = "";

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "gemini_words_daily.json");

const now = new Date();
const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

// 2. Lettura dello stato salvato in memoria
let state = {
  date: "",
  currentIndex: 0,
  words: []
};

if (fm.fileExists(cachePath)) {
  try {
    const rawData = fm.readString(cachePath);
    state = JSON.parse(rawData);
  } catch (e) {
    console.log("Errore lettura cache, la ricreo.");
  }
}

function saveState() {
  fm.writeString(cachePath, JSON.stringify(state));
}

// Themes to rotate through daily, in English (the prompt itself is now in
// English — more effective for targeting real English vocabulary).
const THEMES = [
  "emotions and mental states", "nature and landscapes", "business and economics",
  "science and technology", "art and creativity", "human relationships",
  "food and taste", "travel and places", "time and change", "the body and movement"
];

// Storico leggero delle parole già uscite nei giorni precedenti (max 150),
// usato solo per chiedere a Gemini di non ripeterle. Non è la lista delle
// parole "conosciute": qui restano tutte, anche quelle già viste.
if (!state.history) state.history = [];

// 3. Funzione per scaricare 10 parole da Gemini
async function fetch10Words() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${API_KEY}`;

  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  const recentHistory = state.history.slice(-60); // no need to send the whole history, just the recent ones
  const exclusionText = recentHistory.length > 0
    ? `Do not include any of these words, already used in previous days: ${recentHistory.join(", ")}.`
    : "";

  const promptText = `
  You are helping a native Italian speaker genuinely expand their English vocabulary.

  Generate a list of 10 English words related to the theme "${theme}".

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

  Respond ONLY with a valid JSON array of 10 objects (no markdown, no extra text) with this structure:
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
      temperature: 1.3,   // più alto = scelte lessicali più varie/meno prevedibili
      topP: 0.97,
      topK: 64
    }
  });

  const res = await req.loadJSON();
  if (res.candidates && res.candidates[0].content && res.candidates[0].content.parts[0].text) {
    return JSON.parse(res.candidates[0].content.parts[0].text);
  }
  throw new Error("Risposta non valida da Gemini: " + JSON.stringify(res).slice(0, 300));
}

// 4. Se cambia il giorno o la cache è vuota, scarica 10 parole nuove.
// NESSUN fallback silenzioso: se fallisce, l'errore viene mostrato per intero.
let needsFetch = state.date !== todayStr || !state.words || state.words.length === 0;
let fetchError = null;

if (needsFetch) {
  try {
    state.words = await fetch10Words();
    state.date = todayStr;
    state.currentIndex = 0;

    // Aggiorna lo storico con le parole appena arrivate, tenendo solo le
    // ultime 150 per non far crescere il file all'infinito.
    const newWords = state.words.map(w => w.word).filter(Boolean);
    state.history = [...state.history, ...newWords].slice(-150);

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

// 5. Selezione della parola corrente (quella mostrata nel widget al momento del tocco)
if (state.currentIndex >= state.words.length) state.currentIndex = 0;
const wordData = state.words[state.currentIndex] || state.words[0];

// 6. Costruzione grafica del Widget
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

// 7. Renderizzazione ed Esecuzione
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
Script.complete();
