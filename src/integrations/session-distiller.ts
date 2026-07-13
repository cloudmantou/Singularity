import type { EvidenceAuthorType } from "../memory/evidence-contract";
import type { ObservationExtractionStatus } from "../memory/atomic";

export type DevelopmentSessionRole = "user" | "assistant";
export type DevelopmentSessionMessageIntent =
  | "confirmed_fact"
  | "decision"
  | "preference"
  | "project_state"
  | "question"
  | "hypothesis"
  | "quoted_material"
  | "instruction"
  | "noise";

export interface DevelopmentSessionMessage {
  role: DevelopmentSessionRole;
  content: string;
  messageId?: string;
}

export interface DevelopmentSessionEvidencePlan extends DevelopmentSessionMessage {
  messageIndex: number;
  sourceIdentity: string;
  rootEvidenceId: string;
  revision: number;
  capturedAt: number;
  authorType: EvidenceAuthorType;
  evidenceType: "direct_user_statement" | "ai_summary";
  extractionStatus: ObservationExtractionStatus;
  extractionSkippedReason: string | null;
  messageIntent: DevelopmentSessionMessageIntent | null;
}

const ROLE_MARKER = /(?:^|\n\n)(User|Assistant):\s*/g;
const FACTUAL_INTENTS = new Set<DevelopmentSessionMessageIntent>([
  "confirmed_fact",
  "decision",
  "preference",
  "project_state",
]);

export function classifyDevelopmentSessionMessageIntent(
  content: string
): DevelopmentSessionMessageIntent {
  const value = content.trim();
  if (!value) return "noise";
  if (
    /^(?:>|quote\b|quoted\b|citation\b|引用[：:]?)/i.test(value) ||
    /(?:他说|她说|文档(?:写道|中说)|原文(?:是|为))/.test(value)
  ) return "quoted_material";
  if (
    /^(?:please\s+)?(?:(?:do\s+not|don't|never)\s+(?:remember|note|record|save|store|capture)|forget)(?:\s+that)?\b/i.test(value) ||
    /^(?:请)?(?:(?:不要|别|无需)(?:再)?(?:记住|记录|注明|保存|存储|捕获)|(?:忘记|删除)(?:掉)?)/.test(value)
  ) return "instruction";
  const assertionWrapper = /^(?:please\s+(?:remember|note|record)(?:\s+that)?|can you\s+(?:remember|note|record)(?:\s+that)?|请(?:记住|记录|注明|注意)(?:一下)?[：:]?)\s*/i;
  const unwrapped = value.replace(assertionWrapper, "").trim();
  const wrappedAssertion = unwrapped !== value;
  const semanticValue = wrappedAssertion ? unwrapped.replace(/[?？]\s*$/, "").trim() : value;
  const lower = semanticValue.toLowerCase();
  if (
    /\b(?:maybe|perhaps|possibly|might|could be|hypothesis|assume|suppose|guess)\b/i.test(lower) ||
    /(?:也许|可能|或许|假设|猜测|推测)/.test(semanticValue)
  ) return "hypothesis";
  if (
    /\b(?:we|i)\s+(?:have\s+)?decided\b|\bdecision\s+is\b|\bchose\b|\bselected\b|\badopted\b/i.test(semanticValue) ||
    /(?:我们|我)(?:已经|已)?决定|(?:决定|选择|采用)(?:了|为|使用)/.test(semanticValue)
  ) return "decision";
  if (
    /\b(?:i|we)\s+(?:prefer|like|dislike|want)\b|\bpreference\b/i.test(semanticValue) ||
    /(?:我|我们)(?:更)?(?:喜欢|偏好|不喜欢|希望)/.test(semanticValue)
  ) return "preference";
  if (
    /\b(?:currently|now|completed|finished|deployed|released|blocked|in progress)\b/i.test(semanticValue) ||
    /(?:当前|现在|已经|已)(?:完成|部署|发布|上线|阻塞|进行中|实现)/.test(semanticValue)
  ) return "project_state";
  if (
    !wrappedAssertion && (
      /\?$|？$/.test(semanticValue) ||
      /^(?:what|why|how|when|where|who|which|can|could|would|should|is|are|do|does)\b/i.test(semanticValue) ||
      /^(?:什么|为什么|怎么|如何|是否|能否|可以吗|请问)/.test(semanticValue)
    )
  ) return "question";
  if (
    /^(?:please\b|kindly\b|can you\b|could you\b|update\b|change\b|fix\b|run\b|execute\b|add\b|remove\b)/i.test(semanticValue) ||
    /^(?:请|麻烦|帮我|帮忙|执行|修改|更新|修复|添加|删除|继续)/.test(semanticValue)
  ) return "instruction";
  if (
    /\b(?:is|are|uses|used|has|have|runs|stores|supports|requires|must)\b/i.test(semanticValue) ||
    /(?:是|使用|采用|拥有|支持|依赖|必须|位于|包含)/.test(semanticValue)
  ) return "confirmed_fact";
  return "noise";
}

function normalizeMessage(
  value: Readonly<{ role: string; content: string; messageId?: string }>
): DevelopmentSessionMessage | null {
  const role = value.role.trim().toLowerCase();
  const content = value.content.trim();
  if ((role !== "user" && role !== "assistant") || !content) return null;
  const messageId = value.messageId?.trim().slice(0, 256);
  return { role, content, ...(messageId ? { messageId } : {}) };
}

function stableMessageKey(message: DevelopmentSessionMessage): string {
  const input = `${message.role}\u001f${message.messageId ?? message.content}`;
  let high = 0x9e3779b9;
  let low = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    low = Math.imul(low ^ code, 16777619);
    high = Math.imul(high ^ code, 2246822519);
  }
  return `${(high >>> 0).toString(16).padStart(8, "0")}${(low >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function parseDevelopmentSessionMessages(
  transcript: string
): DevelopmentSessionMessage[] {
  const matches = [...transcript.matchAll(ROLE_MARKER)];
  return matches.flatMap((match, index) => {
    const start = Number(match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? transcript.length;
    const message = normalizeMessage({
      role: match[1],
      content: transcript.slice(start, end),
    });
    return message ? [message] : [];
  });
}

export function normalizeDevelopmentSessionMessages(
  messages: ReadonlyArray<Readonly<{ role: string; content: string; messageId?: string }>> | undefined,
  transcript: string,
  options: { allowTranscriptFallback?: boolean } = {}
): DevelopmentSessionMessage[] {
  const structured = (messages ?? []).flatMap((message) => {
    const normalized = normalizeMessage(message);
    return normalized ? [normalized] : [];
  });
  if (structured.length) return structured;
  return options.allowTranscriptFallback ? parseDevelopmentSessionMessages(transcript) : [];
}

export function formatDevelopmentSessionTranscript(
  messages: readonly DevelopmentSessionMessage[]
): string {
  return messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
}

export function developmentSessionMessagesMatchTranscript(
  messages: readonly DevelopmentSessionMessage[],
  transcript: string
): boolean {
  if (formatDevelopmentSessionTranscript(messages) !== transcript.trim()) return false;
  const parsed = parseDevelopmentSessionMessages(transcript);
  return parsed.length === messages.length && parsed.every((message, index) =>
    message.role === messages[index].role && message.content === messages[index].content
  );
}

export function planDevelopmentSessionEvidence(
  messages: readonly DevelopmentSessionMessage[],
  input: {
    sourceIdentity: string;
    revision: number;
    capturedAt: number;
  }
): DevelopmentSessionEvidencePlan[] {
  const keyOccurrences = new Map<string, number>();
  return messages.map((message, messageIndex) => {
    const userMessage = message.role === "user";
    const messageIntent = userMessage
      ? classifyDevelopmentSessionMessageIntent(message.content)
      : null;
    const shouldExtract = messageIntent !== null && FACTUAL_INTENTS.has(messageIntent);
    const stableKey = stableMessageKey(message);
    const occurrence = keyOccurrences.get(stableKey) ?? 0;
    keyOccurrences.set(stableKey, occurrence + 1);
    const baseIdentityKey = message.messageId
      ? stableKey
      : `revision:${input.revision}:${stableKey}`;
    const identityKey = occurrence === 0
      ? baseIdentityKey
      : `${baseIdentityKey}:${occurrence}`;
    return {
      ...message,
      messageIndex,
      sourceIdentity: `${input.sourceIdentity}:message:${identityKey}`,
      rootEvidenceId: input.sourceIdentity,
      revision: input.revision,
      capturedAt: input.capturedAt,
      authorType: userMessage ? "user" : "assistant",
      evidenceType: userMessage ? "direct_user_statement" : "ai_summary",
      extractionStatus: shouldExtract ? "pending" : "succeeded",
      extractionSkippedReason: shouldExtract
        ? null
        : userMessage
          ? `user_message_intent_not_factual:${messageIntent}`
          : "assistant_message_not_factual_evidence",
      messageIntent,
    };
  });
}
