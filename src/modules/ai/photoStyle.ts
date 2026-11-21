import { normalizeAssetText } from './assetRequests';
export type PhotoMeshStyle = 'smooth' | 'blocky';
const smooth = 'ناعم(?:ه|ة)?|سموث|انسيابي(?:ه|ة)?|املس|ملساء|smooth|rounded';
const blocky = '(?:ب?ال)?بكسل(?:ي|يه|ية|ات)?|فوكسل(?:ي|يه|ية)?|pixel(?:ated|s)?|voxel(?:s)?|blocky|minecraft';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (text: string, words: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words})(?![\\p{L}\\p{N}_])`, 'iu').test(text);
/** Adjacent descriptions win. A single-topic description can also use a global style. */
export function photoStyleForTopic(prompt: string, term: string, topicCount: number): PhotoMeshStyle | 'conflict' {
  const normalized=normalizeAssetText(prompt);
  const negative = (words:string) => new RegExp(`(?<![\\p{L}])(?:بدون|دون|بلا|without|no|not)\\s+(?:${words})(?![\\p{L}])`, 'giu');
  const name=escape(normalizeAssetText(term).trim().replace(/^ال/u,''));
  const negatedForTopic = (words:string) => topicCount === 1 ? negative(words).test(normalized) : new RegExp(`(?<![\\p{L}])(?:و?ال|و)?${name}\\s+(?:بدون|دون|بلا|without|no|not)\\s+(?:${words})(?![\\p{L}])`, 'iu').test(normalized);
  const noSmooth=negatedForTopic(smooth), noBlocky=negatedForTopic(blocky);
  const text=normalized.replace(negative(smooth),' ').replace(negative(blocky),' ');
  const after = (words: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:و?ال|و)?${name}\\s+(?:${words})(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  // For multiple subjects only attach an adjective following that subject;
  // the adjective immediately before it may belong to the previous one.
  let a=after(smooth), b=after(blocky);
  if (topicCount === 1) { a=has(text,smooth); b=has(text,blocky); }
  if ((a && b) || (a && noSmooth) || (b && noBlocky) || (noSmooth && noBlocky)) return 'conflict';
  if (noSmooth) return 'blocky';
  return b ? 'blocky' : 'smooth';
}
