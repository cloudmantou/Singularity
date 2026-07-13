#!/usr/bin/env node
'use strict';

const { readProjectContext } = require('./context.cjs');

async function main() {
  const baseUrl = process.env.SECOND_BRAIN_URL;
  const token = process.env.SECOND_BRAIN_TOKEN;
  if (!baseUrl || !token) return;

  const project = readProjectContext(process.cwd());
  const query = `User is continuing work on ${project.repository} branch ${project.branch}. Recall current project status, confirmed decisions, unresolved problems, and established workflows.`;

  let data;
  try {
    const url = new URL('/recall', baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('topK', '8');
    url.searchParams.set('hops', '1');
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }

  const results = (data?.results ?? data?.data ?? []);
  if (!results.length) return;

  const formatted = results
    .slice(0, 8)
    .map((r, i) => {
      const association = r.association
        ? ` [association:${r.association.viaType || r.association.via_type}, ${r.association.hop} hop]`
        : '';
      return `${i + 1}.${association} ${String(r.content ?? '').trim()}`;
    })
    .filter(line => line.length > 3)
    .join('\n');

  if (formatted) {
    const conflicts = Array.isArray(data?.conflicts) && data.conflicts.length
      ? `\nUnresolved conflicts: ${data.conflicts.map((item) => item.id).join(', ')}`
      : '';
    process.stdout.write(`[Singularity] ${project.repository}@${project.branch} context:\n${formatted}${conflicts}\n`);
  }
}

main().catch(() => {});
