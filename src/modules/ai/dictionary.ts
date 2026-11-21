import { z } from 'zod';

export const dictionaryResponseSchema = z.object({
  entries: z.array(z.object({
    language: z.enum(['ar', 'fr', 'en']),
    partOfSpeech: z.string().min(1).max(80),
    definition: z.string().min(1).max(400),
  }).strict()).max(192),
  complete: z.boolean(),
}).strict();
export type DictionaryResponse = z.infer<typeof dictionaryResponseSchema>;

/** Same fixed-host page as the API, with the word as a path segment, never an arbitrary URL. */
export function dictionaryPage(word: string): string {
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`;
}

/** The service is a word dictionary, not a translator or a phrase parser. */
export function isDictionaryWord(word: string): boolean {
  return /^[\p{L}]{2,80}$/u.test(word);
}
