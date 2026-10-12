const PAST_PATTERN =
  /\b(before|previous(ly)?|used to|formerly|former|earlier|in the past|past|history|historical|originally|back then|ago|anymore|did i (?:use|have|drive|own|live|work)|what did i|where did i|was i|were my|had i|old (?:car|job|address|home|apartment|phone))\b/i;

/**
 * True when a question asks how things were rather than how they are. Past facts
 * (historical memories) are only recalled for such questions.
 */
export function hasHistoricalIntent(query: string): boolean {
  return PAST_PATTERN.test(query);
}
