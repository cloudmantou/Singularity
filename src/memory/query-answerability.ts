export type ClaimAnswerability = "answerable" | "related" | "irrelevant";

export interface ClaimAnswerabilityRank {
  queryRelevance: number;
  answerability: ClaimAnswerability;
}

const GENERIC_QUERY_WORDS = new Set([
  "a", "an", "and", "app", "are", "current", "do", "does", "for", "how",
  "in", "is", "me", "of", "on", "please", "project", "query", "system",
  "tell", "the", "this", "to", "use", "used", "uses", "what", "when",
  "where", "which", "who", "why",
]);

const GENERIC_CJK_QUERY_TEXT = /项目|系统|应用|请问|请告诉我|是什么|是多少|如何|怎么|当前|目前|哪个|什么|是否|的|吗/g;

const CONCEPTS: ReadonlyArray<{ query: RegExp; statement: RegExp }> = [
  { query: /database|\bdb\b|数据库|数据存储/i, statement: /database|\bdb\b|sqlite|postgres|mysql|数据库/i },
  { query: /auth|authentication|authorization|认证|鉴权|授权/i, statement: /auth|jwt|oauth|token|认证|鉴权|授权/i },
  { query: /port|端口/i, statement: /port|listen|端口|:[0-9]{2,5}\b/i },
  { query: /version|minimum|platform|ios|android|版本|最低|平台/i, statement: /version|minimum|deployment target|ios|android|版本|最低/i },
  { query: /deadline|due date|截止|期限/i, statement: /deadline|due date|截止|期限|[0-9]{4}-[0-9]{2}-[0-9]{2}/i },
  { query: /owner|responsible|负责人/i, statement: /owner|responsible|负责人/i },
];

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function informativeTokens(query: string): string[] {
  const normalized = normalizeText(query);
  const latin = normalized.match(/[a-z0-9][a-z0-9._+-]*/g) ?? [];
  const usefulLatin = latin.filter((token) => token.length > 1 && !GENERIC_QUERY_WORDS.has(token));
  const cjk = normalized.replace(GENERIC_CJK_QUERY_TEXT, "").match(/[\u3400-\u9fff]/g) ?? [];
  const cjkBigrams = cjk.length === 1
    ? cjk
    : cjk.slice(0, -1).map((character, index) => `${character}${cjk[index + 1]}`);
  return [...new Set([...usefulLatin, ...cjkBigrams])];
}

function lexicalCoverage(query: string, statement: string): number {
  const tokens = informativeTokens(query);
  if (!tokens.length) return 0;
  const normalizedStatement = normalizeText(statement);
  const matches = tokens.filter((token) => normalizedStatement.includes(token)).length;
  return matches / tokens.length;
}

function conceptCoverage(query: string, statement: string): number {
  const queried = CONCEPTS.filter((concept) => concept.query.test(query));
  if (!queried.length) return 0;
  const supported = queried.filter((concept) => concept.statement.test(statement)).length;
  return supported / queried.length;
}

function clampScore(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, Number(value))) : 0;
}

export function rankClaimAnswerability(
  query: string,
  statement: string,
  semanticScore?: number | null
): ClaimAnswerabilityRank {
  const queryRelevance = Number(Math.max(
    lexicalCoverage(query, statement),
    conceptCoverage(query, statement),
    clampScore(semanticScore)
  ).toFixed(4));
  return {
    queryRelevance,
    answerability: queryRelevance >= 0.6
      ? "answerable"
      : queryRelevance >= 0.25
        ? "related"
        : "irrelevant",
  };
}
