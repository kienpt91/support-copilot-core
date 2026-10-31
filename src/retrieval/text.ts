const STOPWORDS = new Set(
  (
    "a about after all also am an and any are as at be been being but by can could did do does doing for from had has have " +
    "having he her here him his how i if in into is it its just me my of on or our out over she so some than that the their " +
    "them then there these they this those to too up us was we were what when where which while who why will with would you your"
  ).split(" "),
);

const STATIC_TAG = /\[(?:EMAIL|PHONE|CARD|IBAN|NATIONAL_ID)\]/g;

/** Plural stripping only. Deliberately light: the vector side is what handles other word forms. */
export function stem(word: string): string {
  if (word.length <= 3 || !/^[a-z]+$/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
  if (word.endsWith("es") && /(?:ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Lower-cases, folds accents, splits on non-alphanumerics, drops stopwords and 1-letter words, stems plurals. */
export function tokenize(text: string): string[] {
  const folded = text.replace(STATIC_TAG, " ").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  const words = folded.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    if (w.length === 1 && !/\d/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/** Splits text into sentences on ., ! and ? followed by whitespace. Keeps the punctuation. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    for (const part of trimmed.split(/(?<=[.!?]["')\]]?)\s+/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}
