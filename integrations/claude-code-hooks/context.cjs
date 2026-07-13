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

function formatTranscript(messages, maxChars = 20_000) {
  if (!Array.isArray(messages)) return '';
  const rows = messages
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .map((message) => ({ role: message.role, text: messageText(message.content) }))
    .filter((message) => message.text)
    .slice(-20)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`);
  const transcript = rows.join('\n\n');
  if (transcript.length <= maxChars) return transcript;
  return transcript.slice(transcript.length - maxChars);
}

module.exports = { formatTranscript, readProjectContext };
