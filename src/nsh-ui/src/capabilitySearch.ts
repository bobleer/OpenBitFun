import { isRetiredVoiceDestination, type ControlDestination, type ControlSurfaceTarget } from "./controlPresenter";
import catalog from "./generated/interactiveCapabilities.json";
import type { SearchItem } from "./globalSearchStore";
import { currentLocale } from "./i18n";

interface Titles {
  titleZh: string;
  titleEn: string;
}

interface CatalogEntry extends Titles {
  id: string;
  kind: "feature" | "setting";
  summaryZh: string;
  summaryEn: string;
  searchTerms: string[];
  destination: ControlDestination;
  items: Array<Titles & { id: string; destination?: ControlDestination }>;
}

const wordBoundary = /[\s._/\\:-]+/u;
const cjk = /[\u3400-\u9fff]/u;

function fieldsFor(values: string[]) {
  return [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))].map(text => {
    const words = text.split(wordBoundary).filter(Boolean);
    return { text, words, initials: words.map(word => word[0]).join("") };
  });
}

function buildIndex() {
  return (catalog.capabilities as CatalogEntry[]).flatMap(entry => {
    const destination = isRetiredVoiceDestination(entry.destination) ? undefined : entry.destination;
    const available = entry.items.filter(item => !isRetiredVoiceDestination(item.destination ?? entry.destination));
    if (!destination && available.length === 0) return [];
    // Input and Pet also contain supported options. Index those options and
    // the page title without the shared catalog's voice-related terms or summary.
    const hasRetiredOptions = !destination || available.length !== entry.items.length;
    const titleTerms = [entry.titleZh, entry.titleEn];
    return [{
      entry,
      destination,
      hasRetiredOptions,
      fields: fieldsFor(hasRetiredOptions
        ? [...titleTerms, ...available.flatMap(item => [item.titleZh, item.titleEn])]
        : entry.searchTerms),
      titles: fieldsFor(titleTerms),
      items: available.map(item => ({ item, fields: fieldsFor([item.titleZh, item.titleEn]) })),
    }];
  });
}

let index: ReturnType<typeof buildIndex> | undefined;

function scoreTerm(term: string, field: ReturnType<typeof fieldsFor>[number]): number {
  if (term === field.text) return 100;
  if (field.text.startsWith(term)) return 94;
  if (field.words.some(word => word.startsWith(term))) return 88;
  if (field.text.includes(term)) return 80;
  return term.length > 1 && field.initials.includes(term) ? 66 : 0;
}

function scoreFields(query: string, tokens: string[], fields: ReturnType<typeof fieldsFor>): number {
  let exact = 0;
  for (const field of fields) exact = Math.max(exact, scoreTerm(query, field));
  if (tokens.length < 2 || exact >= 80) return exact;
  if (fields.some(field => tokens.every(token => field.text.includes(token)))) return Math.max(exact, 74);
  if (tokens.every(token => fields.some(field => field.text.includes(token)))) return Math.max(exact, 72);
  const ranks = tokens.map(token => fields.reduce((best, field) => Math.max(best, scoreTerm(token, field)), 0))
    .filter(score => score > 0);
  return ranks.length ? Math.max(exact, Math.round(38 + ranks.length / tokens.length * 28 + Math.max(...ranks) * 0.08)) : exact;
}

export function capabilitySearchItems(
  rawQuery: string,
  resolve: (destination: ControlDestination) => ControlSurfaceTarget | null,
): SearchItem[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const tokens = query.split(wordBoundary).filter(token => token.length >= 2 || cjk.test(token));
  const chinese = currentLocale().startsWith("zh");
  const title = (titles: Titles) => chinese ? titles.titleZh : titles.titleEn;
  const hits: Array<{ item: SearchItem; score: number; titleScore: number; itemScore: number }> = [];

  for (const { entry, destination: page, hasRetiredOptions, fields, titles, items } of index ??= buildIndex()) {
    const score = scoreFields(query, tokens, fields);
    if (!score) continue;
    const titleScore = scoreFields(query, tokens, titles);
    let best: CatalogEntry["items"][number] | undefined;
    let itemScore = 0;
    for (const { item, fields: itemFields } of items) {
      const rank = scoreFields(query, tokens, itemFields);
      if (rank < 72 || rank <= itemScore) continue;
      best = item;
      itemScore = rank;
    }
    let destination = best?.destination ?? page;
    if (!destination || !resolve(destination)) {
      if (titleScore < 80 || !page || !resolve(page)) continue;
      best = undefined;
      itemScore = 0;
      destination = page;
    }
    hits.push({
      score, titleScore, itemScore,
      item: {
        id: `capability:${entry.id}`,
        kind: entry.kind === "setting" ? "setting" : "capability",
        label: title(entry),
        detail: best ? title(best) : hasRetiredOptions ? "" : chinese ? entry.summaryZh : entry.summaryEn,
        target: entry.id,
        controlDestination: destination,
      },
    });
  }

  const hasCompleteMatch = tokens.length > 1 && hits.some(hit => hit.score >= 72);
  return hits
    .filter(hit => !hasCompleteMatch || hit.score >= 72)
    .sort((a, b) => b.score - a.score || b.titleScore - a.titleScore || b.itemScore - a.itemScore
      || a.item.id.localeCompare(b.item.id))
    .slice(0, 20)
    .map(hit => hit.item);
}
