#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const {
  extractTranscriptMessages,
  formatTranscript,
  readProjectContext,
} = require('./context.cjs');

async function main() {
  const baseUrl = process.env.SECOND_BRAIN_URL;
  const token = process.env.SECOND_BRAIN_TOKEN;
  if (!baseUrl || !token) return;

  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 1_000_000) break;
    }
  } catch {
    return;
  }

  if (!raw.trim()) return;

  let transcript;
  try {
    transcript = JSON.parse(raw);
  } catch {
    return;
  }

  const messages = transcript?.messages ?? transcript?.conversation ?? [];
  if (!Array.isArray(messages) || messages.length === 0) return;

  const content = formatTranscript(messages);
  const structuredMessages = extractTranscriptMessages(messages);
  if (content.length < 50) return;
  const project = readProjectContext(process.cwd());
  const sessionId = String(
    transcript?.session_id || transcript?.sessionId || crypto.randomUUID()
  ).slice(0, 256);

  try {
    await fetch(`${baseUrl}/integrations/development-session/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client: 'claude-code',
        repository: project.repository,
        branch: project.branch,
        sessionId,
        capturedAt: Date.now(),
        transcript: content,
        messages: structuredMessages,
      }),
    });
  } catch {
    // silent — hooks must not disrupt session close
  }
}

main().catch(() => {});
