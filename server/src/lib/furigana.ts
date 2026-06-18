/**
 * Strip Anki-style ruby annotations (`漢字[かんじ]`) back to plain text.
 *
 * Expression fields may carry furigana on proper nouns using Anki's
 * `base[reading]` syntax (optionally preceded by a delimiting space). When we
 * feed a sentence to the enrichment model we want the bare Japanese, not the
 * bracketed readings — otherwise the model treats the brackets as content.
 */
export function stripFurigana(text: string): string {
  return text.replace(/ ?([^ \[]+)\[[^\]]*\]/g, '$1');
}
