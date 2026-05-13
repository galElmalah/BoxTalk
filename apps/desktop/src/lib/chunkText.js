// Split long text into TTS-friendly chunks on sentence/paragraph boundaries.
// Imported from both the renderer (App.jsx) and main process (digest engine).
//
// Target chunk size keeps each synthesis call short enough that Kokoro
// stays responsive (multi-thousand-character inputs slow it down and
// produce gappier prosody at chunk seams).

const TARGET_CHARS = 600;
const HARD_LIMIT = 1200;

function splitIntoSentences(text) {
  const out = [];
  const re = /[^.!?\n]+[.!?]+(?=\s|$)|[^.!?\n]+\n+|[^.!?\n]+$/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const piece = m[0].trim();
    if (piece) out.push(piece);
  }
  return out;
}

function hardSplit(piece, hardLimit) {
  const out = [];
  let buf = "";
  for (const word of piece.split(/\s+/)) {
    if (!word) continue;
    if (buf.length + word.length + 1 > hardLimit) {
      if (buf) out.push(buf);
      buf = word;
    } else {
      buf = buf ? buf + " " + word : word;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function chunkText(text, { target = TARGET_CHARS, hardLimit = HARD_LIMIT } = {}) {
  const cleaned = (text || "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  const sentences = splitIntoSentences(cleaned).flatMap((s) =>
    s.length > hardLimit ? hardSplit(s, hardLimit) : [s],
  );

  const chunks = [];
  let buf = "";
  for (const s of sentences) {
    if (!buf) {
      buf = s;
    } else if (buf.length + 1 + s.length <= target) {
      buf = buf + " " + s;
    } else {
      chunks.push(buf);
      buf = s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}
