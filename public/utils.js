/* utils.js — helper functions for the Singularity UI.
 *
 * In production these are served from the Worker root. This file mirrors
 * them so the UI is fully functional in preview / offline as well.
 * (Path resolves to the same /utils.js when index.html is served at root.)
 */

/* Escape text for safe insertion into HTML. */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Escape text for safe insertion into a single-quoted HTML attribute / inline JS string. */
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');
}

/* yyyy-mm-dd in local time, for day-grouping. */
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeConnectionBase(value) {
  const raw = String(value == null ? '' : value).trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.href.replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

function scopedConnectionStorageKeys(pageOrigin) {
  const scope = normalizeConnectionBase(pageOrigin);
  return {
    url: `sb_url:${scope}`,
    token: `sb_token:${scope}`,
  };
}

function connectionOrigin(value) {
  const normalized = normalizeConnectionBase(value);
  if (!normalized) return '';
  try {
    return new URL(normalized).origin;
  } catch (_) {
    return '';
  }
}

/* Resolve saved credentials only within the page that created them. Legacy
 * global credentials are accepted solely when their server origin equals the
 * current page origin, preventing a local dashboard from silently calling a
 * previously visited production deployment. */
function resolveStoredConnection(storage, pageOrigin) {
  const pageBase = normalizeConnectionBase(pageOrigin);
  const keys = scopedConnectionStorageKeys(pageBase);
  const scopedUrl = normalizeConnectionBase(storage.getItem(keys.url));
  const scopedToken = String(storage.getItem(keys.token) || '').trim();
  if (scopedUrl && scopedToken) {
    return { url: scopedUrl, token: scopedToken, source: 'scoped' };
  }

  const legacyUrl = normalizeConnectionBase(storage.getItem('sb_url'));
  const legacyToken = String(storage.getItem('sb_token') || '').trim();
  if (
    legacyUrl &&
    legacyToken &&
    connectionOrigin(legacyUrl) === connectionOrigin(pageBase)
  ) {
    return { url: legacyUrl, token: legacyToken, source: 'legacy' };
  }

  return { url: pageBase, token: '', source: 'none' };
}

function storeScopedConnection(storage, pageOrigin, serverUrl, token) {
  const pageBase = normalizeConnectionBase(pageOrigin);
  const url = normalizeConnectionBase(serverUrl);
  const normalizedToken = String(token || '').trim();
  if (!pageBase || !url || !normalizedToken) return false;
  const keys = scopedConnectionStorageKeys(pageBase);
  storage.setItem(keys.url, url);
  storage.setItem(keys.token, normalizedToken);

  if (connectionOrigin(storage.getItem('sb_url')) === connectionOrigin(pageBase)) {
    storage.removeItem('sb_url');
    storage.removeItem('sb_token');
  }
  return true;
}

function clearScopedConnection(storage, pageOrigin) {
  const pageBase = normalizeConnectionBase(pageOrigin);
  const keys = scopedConnectionStorageKeys(pageBase);
  storage.removeItem(keys.url);
  storage.removeItem(keys.token);
  if (connectionOrigin(storage.getItem('sb_url')) === connectionOrigin(pageBase)) {
    storage.removeItem('sb_url');
    storage.removeItem('sb_token');
  }
}

const D1_MAX_TAG_UTF8_BYTES = 46;

/* Return the canonical stored tag, or null when its normalized UTF-8 payload
 * cannot safely participate in D1's JSON LIKE patterns. */
function normalizeSafeTag(tag) {
  const normalized = String(tag).toLowerCase();
  return new TextEncoder().encode(normalized).byteLength <= D1_MAX_TAG_UTF8_BYTES
    ? normalized
    : null;
}

/* Parse the text returned by the `recall` MCP tool into entry objects.
 * Tolerant of a few shapes: JSON array, or a numbered / bulleted text list
 * with an optional [NN%] score, inline #hashtags, and a trailing (id: …).
 * Returns: [{ score, content, tags: string[], id }]
 */
function parseRecallResult(result) {
  if (!result) return [];

  // 1) JSON payload
  try {
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    const arr = Array.isArray(data) ? data : (data.results || data.memories || data.entries);
    if (Array.isArray(arr)) {
      return arr.map(e => normalizeEntry(e));
    }
  } catch (_) { /* not JSON — fall through to text parsing */ }

  // 2) Text list
  const text = String(result);
  const blocks = text
    .split(/\n(?=\s*(?:\d+[.)]|[-*•]|\[))/)   // split on new list items
    .map(b => b.trim())
    .filter(Boolean);

  const entries = [];
  blocks.forEach(block => {
    let body = block.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '');

    // score like [87%] or (87%)
    let score = null;
    const sm = body.match(/[\[(]\s*(\d{1,3})\s*%\s*[\])]/);
    if (sm) { score = parseInt(sm[1], 10); body = body.replace(sm[0], '').trim(); }

    // trailing (id: xxx)
    let id = null;
    const im = body.match(/\(id:\s*([^)]+)\)\s*$/i);
    if (im) { id = im[1].trim(); body = body.replace(im[0], '').trim(); }

    // hashtags
    const tags = [];
    let tm; const tagRe = /(?<![\p{L}\p{N}_])#([\p{L}\p{N}_-]+)/gu;
    while ((tm = tagRe.exec(body)) !== null) {
      const normalized = normalizeSafeTag(tm[1]);
      if (normalized !== null) tags.push(normalized);
    }
    const content = body
      .replace(/(?<![\p{L}\p{N}_])#[\p{L}\p{N}_-]+/gu, match => normalizeSafeTag(match.slice(1)) !== null ? '' : match)
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (content) {
      entries.push({
        score: score == null ? 0 : score,
        content,
        tags,
        id
      });
    }
  });

  return entries;
}

/* Coerce a structured recall entry into the shape the UI expects. */
function normalizeEntry(e) {
  let tags = e.tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch (_) { tags = tags ? [tags] : []; }
  }
  if (!Array.isArray(tags)) tags = [];
  let score = e.score != null ? e.score : (e.similarity != null ? e.similarity : 0);
  if (score > 0 && score <= 1) score = Math.round(score * 100);   // 0–1 rank → 0–100 scale
  return {
    score: Math.round(score) || 0,
    relevance: e.relevance || null,
    content: e.content != null ? e.content : (e.text || ''),
    tags,
    id: e.id != null ? e.id : null
  };
}

/* Incremental parser for the dashboard's `data: {"response":"..."}` SSE stream.
 * Network reads may split an event at any byte boundary, so parsing is deferred
 * until a blank-line event delimiter has arrived.
 */
function createCfSseParser(handlers) {
  const onResponse = handlers && typeof handlers.onResponse === 'function'
    ? handlers.onResponse
    : function () {};
  const onDone = handlers && typeof handlers.onDone === 'function'
    ? handlers.onDone
    : function () {};
  const onError = handlers && typeof handlers.onError === 'function'
    ? handlers.onError
    : function () {};
  let buffer = '';
  let completed = false;

  function consumeEvent(eventText) {
    const data = eventText
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) return;
    if (data === '[DONE]') {
      if (!completed) onDone();
      completed = true;
      return;
    }
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed.response === 'string' && parsed.response) {
        onResponse(parsed.response);
      }
    } catch (error) {
      onError(error);
    }
  }

  function drain(allowRemainder) {
    let match;
    while ((match = buffer.match(/\r?\n\r?\n/))) {
      const end = match.index;
      consumeEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + match[0].length);
    }
    if (allowRemainder && buffer.trim()) {
      consumeEvent(buffer);
      buffer = '';
    }
  }

  return {
    push(text) {
      if (!text) return;
      buffer += text;
      drain(false);
    },
    finish() {
      drain(true);
    },
  };
}

/* Incremental parser for Recall SSE events. The server emits answer text only
 * after verification; the final payload remains authoritative metadata. */
function createRecallSseParser(handlers) {
  const callbacks = handlers || {};
  let buffer = '';
  let completed = false;
  let failed = false;

  function invoke(name, value) {
    const handler = callbacks[name];
    if (typeof handler === 'function') handler(value);
  }

  function fail(error) {
    if (failed) return;
    failed = true;
    invoke('onError', error instanceof Error ? error : new Error('Recall stream failed'));
  }

  function consumeEvent(eventText) {
    const data = eventText
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) return;
    if (failed) return;
    if (completed) {
      fail(new Error('Recall stream produced an event after DONE'));
      return;
    }
    if (data === '[DONE]') {
      if (!completed) invoke('onDone');
      completed = true;
      return;
    }
    try {
      const event = JSON.parse(data);
      if (!event || typeof event !== 'object') throw new Error('Invalid Recall SSE event');
      if (event.type === 'status' && typeof event.phase === 'string') {
        invoke('onStatus', event.phase);
      } else if (event.type === 'draft_delta' && typeof event.delta === 'string') {
        invoke('onDraftDelta', event.delta);
      } else if (event.type === 'final' && event.data && typeof event.data === 'object') {
        invoke('onFinal', event.data);
      } else if (event.type === 'error') {
        fail(new Error(
          typeof event.message === 'string' && event.message
            ? event.message
            : 'Recall stream failed'
        ));
      }
    } catch (error) {
      fail(error);
    }
  }

  function drain(allowRemainder) {
    let match;
    while ((match = buffer.match(/\r?\n\r?\n/))) {
      const end = match.index;
      consumeEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + match[0].length);
    }
    if (allowRemainder && buffer.trim()) {
      consumeEvent(buffer);
      buffer = '';
    }
  }

  return {
    push(text) {
      if (!text) return;
      if (failed) return;
      if (completed) {
        if (text.trim()) fail(new Error('Recall stream produced data after DONE'));
        return;
      }
      buffer += text;
      drain(false);
    },
    finish() {
      drain(true);
    },
  };
}

async function consumeRecallSseResponse(response, handlers) {
  if (!response || !response.ok) {
    throw new Error(`Recall failed (HTTP ${response ? response.status : 0})`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Recall stream body is unavailable');
  }

  const callbacks = handlers || {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let finalData = null;
  let finalCount = 0;
  let done = false;
  let protocolError = null;
  const parser = createRecallSseParser({
    onStatus(phase) {
      if (finalCount === 0 && typeof callbacks.onStatus === 'function') {
        callbacks.onStatus(phase);
      }
    },
    onDraftDelta(delta) {
      if (finalCount === 0 && typeof callbacks.onDraftDelta === 'function') {
        callbacks.onDraftDelta(delta);
      }
    },
    onFinal(data) {
      finalCount += 1;
      if (finalCount > 1) {
        protocolError = new Error('Recall stream produced multiple final responses');
        return;
      }
      finalData = data;
    },
    onError(error) {
      protocolError = error instanceof Error ? error : new Error('Recall stream failed');
    },
    onDone() {
      done = true;
    },
  });

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parser.push(decoder.decode(next.value, { stream: true }));
      if (protocolError) {
        await reader.cancel(protocolError).catch(() => undefined);
        throw protocolError;
      }
    }
    parser.push(decoder.decode());
    parser.finish();
    if (protocolError) throw protocolError;
  } finally {
    reader.releaseLock();
  }

  if (protocolError) throw protocolError;
  if (!done) throw new Error('Recall stream ended before DONE');
  if (finalCount !== 1 || !finalData) {
    throw new Error('Recall stream ended without a final response');
  }
  if (typeof callbacks.onFinal === 'function') callbacks.onFinal(finalData);
  return finalData;
}

/* Reveal verified Recall prose independently of network chunk sizes. The final
 * payload applies citations and formatting after the queue has drained. */
function createRecallDraftAnimator(options) {
  const settings = options || {};
  const intervalMs = Number.isFinite(settings.intervalMs)
    ? Math.max(1, settings.intervalMs)
    : 14;
  const onText = typeof settings.onText === 'function'
    ? settings.onText
    : () => {};
  let rawText = '';
  let queuedText = '';
  let visibleText = '';
  let pending = [];
  let timer = null;
  let completed = false;
  let cancelled = false;
  let drainWaiters = [];

  function sanitizeDraft(value, complete) {
    const withoutCitations = value.replace(/\s*\[\s*C\d+\s*\]/gi, '');
    return complete
      ? withoutCitations
      : withoutCitations.replace(/\s*\[\s*C?\d*$/i, '');
  }

  function resolveDrainWaiters() {
    if (pending.length || timer) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    waiters.forEach(resolve => resolve());
  }

  function scheduleTick() {
    if (cancelled || timer || !pending.length) {
      resolveDrainWaiters();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) {
        resolveDrainWaiters();
        return;
      }
      const character = pending.shift();
      if (character != null) {
        visibleText += character;
        onText(visibleText, character);
      }
      scheduleTick();
    }, intervalMs);
  }

  function enqueueSanitized(complete) {
    const nextText = sanitizeDraft(rawText, complete);
    if (!nextText.startsWith(queuedText)) return;
    const suffix = nextText.slice(queuedText.length);
    queuedText = nextText;
    if (suffix) pending.push(...Array.from(suffix));
    scheduleTick();
  }

  return {
    push(chunk) {
      if (cancelled || completed || !chunk) return;
      rawText += chunk;
      enqueueSanitized(false);
    },
    finish() {
      if (cancelled) return Promise.resolve();
      if (!completed) {
        completed = true;
        enqueueSanitized(true);
      }
      if (!pending.length && !timer) return Promise.resolve();
      return new Promise(resolve => {
        drainWaiters.push(resolve);
      });
    },
    cancel() {
      cancelled = true;
      pending = [];
      if (timer) clearTimeout(timer);
      timer = null;
      resolveDrainWaiters();
    },
  };
}

/* Parse a state-changing REST response and enforce its { ok: true } contract.
 * The response body is never reflected on malformed/non-JSON failures because
 * upstream HTML can contain private diagnostics.
 */
async function parseApiJsonResponse(response, fallbackMessage, options) {
  const fallback = fallbackMessage || 'Request failed';
  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error(`${fallback} (HTTP ${response.status})`);
  }

  const acceptedDuplicate = response.ok && options && options.allowDuplicate === true
    && data && data.duplicate === true;
  if (!acceptedDuplicate && (!response.ok || !data || data.ok !== true)) {
    const message = data && typeof data.error === 'string' && data.error.trim()
      ? data.error.trim()
      : `${fallback} (HTTP ${response.status})`;
    throw new Error(message);
  }
  return data;
}

/* Import backup rows without exceeding the Cloudflare D1 per-invocation query
 * budget. Awaiting every callback before taking the next slice also prevents a
 * large restore from creating concurrent write bursts. */
async function importEntriesInBatches(entries, sendBatch, batchSize) {
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 4;
  const totals = {
    ok: true,
    inserted: 0,
    skipped: 0,
    updated: 0,
    failed: 0,
    pendingVectorizeCount: 0,
  };
  for (let offset = 0; offset < entries.length; offset += size) {
    const batch = await sendBatch(entries.slice(offset, offset + size));
    totals.inserted += Number(batch && batch.inserted || 0);
    totals.skipped += Number(batch && batch.skipped || 0);
    totals.updated += Number(batch && batch.updated || 0);
    totals.failed += Number(batch && batch.failed || 0);
    totals.pendingVectorizeCount += Number(
      batch && (batch.pendingVectorizeCount ?? (batch.pendingVectorize || []).length) || 0
    );
  }
  return totals;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escHtml,
    escAttr,
    toDateStr,
    parseRecallResult,
    normalizeEntry,
    createCfSseParser,
    createRecallSseParser,
    createRecallDraftAnimator,
    consumeRecallSseResponse,
    parseApiJsonResponse,
    normalizeSafeTag,
    importEntriesInBatches,
    resolveStoredConnection,
    scopedConnectionStorageKeys,
    storeScopedConnection,
    clearScopedConnection,
  };
}
