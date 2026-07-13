'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

function gitValue(args, cwd, fallback) {
  try {
    const value = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function readProjectContext(cwd = process.cwd()) {
  const root = gitValue(['rev-parse', '--show-toplevel'], cwd, cwd);
  const repository = path.basename(root) || 'project';
  const branch = gitValue(['branch', '--show-current'], cwd, 'detached');
  return { repository, branch, root };
}

function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => String(part.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

function extractTranscriptMessages(messages, maxChars = 20_000) {
  if (!Array.isArray(messages)) return [];
  const rows = messages
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .map((message) => {
      const rawId = message.uuid ?? message.id ?? message.message_id;
      const messageId = typeof rawId === 'string' ? rawId.trim().slice(0, 256) : '';
      return {
        role: message.role,
        text: messageText(message.content),
        ...(messageId ? { messageId } : {}),
      };
    })
    .filter((message) => message.text)
    .slice(-20);
  const selected = [];
  let used = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const prefixLength = (row.role === 'user' ? 'User: ' : 'Assistant: ').length;
    const separatorLength = selected.length ? 2 : 0;
    const remaining = maxChars - used - prefixLength - separatorLength;
    if (remaining <= 0) break;
    if (row.text.length > remaining) break;
    const content = row.text;
    selected.unshift({
      role: row.role,
      content,
      ...(row.messageId ? { messageId: row.messageId } : {}),
    });
    used += prefixLength + content.length + separatorLength;
  }
  return selected;
}

function formatTranscript(messages, maxChars = 20_000) {
  return extractTranscriptMessages(messages, maxChars)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n');
}

module.exports = { extractTranscriptMessages, formatTranscript, readProjectContext };
