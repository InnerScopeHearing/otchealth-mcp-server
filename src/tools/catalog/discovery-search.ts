export type DiscoveryTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type DiscoverySearchOptions = {
  query: string;
  limit?: number;
  includeSchema?: boolean;
};

export type DiscoverySearchMatch = Pick<DiscoveryTool, 'name'> &
  Partial<Pick<DiscoveryTool, 'description' | 'inputSchema'>>;

export type DiscoverySearchResult = {
  matches: DiscoverySearchMatch[];
  totalMatches: number;
  truncated: boolean;
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_QUERY_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 160;

/** Searches only the tool contracts supplied by an already-authorized caller. */
export function searchDiscoveryTools(
  tools: readonly DiscoveryTool[],
  options: DiscoverySearchOptions,
): DiscoverySearchResult {
  if (!Array.isArray(tools) || !options || typeof options !== 'object') {
    throw new TypeError('Invalid discovery search input');
  }
  if (typeof options.query !== 'string' || options.query.length > MAX_QUERY_LENGTH) {
    throw new TypeError('Invalid discovery search query');
  }

  const query = options.query.trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) throw new TypeError('Invalid discovery search query');

  const requestedLimit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new TypeError('Invalid discovery search options');
  }
  if (options.includeSchema !== undefined && typeof options.includeSchema !== 'boolean') {
    throw new TypeError('Invalid discovery search options');
  }
  const limit = Math.min(requestedLimit, MAX_LIMIT);

  const ranked = tools.flatMap((tool, index) => {
    if (!tool || typeof tool.name !== 'string' || tool.name.trim() === '') return [];
    const name = tool.name.trim().toLowerCase();
    const description = typeof tool.description === 'string' ? tool.description : '';
    const searchableDescription = description.toLowerCase();
    const exact = name === query;
    const nameTerms = terms.every((term) => name.includes(term));
    const descriptionTerms = terms.every((term) => searchableDescription.includes(term));
    if (!exact && !nameTerms && !descriptionTerms) return [];

    return [{
      tool,
      index,
      rank: exact ? 0 : nameTerms ? 1 : 2,
      sortName: name,
    }];
  }).sort((left, right) =>
    left.rank - right.rank ||
    (left.sortName < right.sortName ? -1 : left.sortName > right.sortName ? 1 : left.index - right.index),
  );

  const matches = ranked.slice(0, limit).map(({ tool }) => {
    const match: DiscoverySearchMatch = { name: tool.name };
    if (typeof tool.description === 'string') {
      const summary = tool.description.trim();
      match.description = summary.length <= MAX_DESCRIPTION_LENGTH
        ? summary
        : `${summary.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`;
    }
    if (options.includeSchema === true && tool.inputSchema !== undefined) {
      match.inputSchema = tool.inputSchema;
    }
    return match;
  });

  return {
    matches,
    totalMatches: ranked.length,
    truncated: ranked.length > matches.length,
  };
}
