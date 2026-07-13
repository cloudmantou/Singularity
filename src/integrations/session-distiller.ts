import type { EvidenceAuthorType } from "../memory/evidence-contract";
import type { ObservationExtractionStatus } from "../memory/atomic";

export type DevelopmentSessionRole = "user" | "assistant";

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
}

const ROLE_MARKER = /(?:^|\n\n)(User|Assistant):\s*/g;

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
      extractionStatus: userMessage ? "pending" : "succeeded",
      extractionSkippedReason: userMessage
        ? null
        : "assistant_message_not_factual_evidence",
    };
  });
}
