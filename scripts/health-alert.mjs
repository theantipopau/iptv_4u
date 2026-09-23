// Daily check behind .github/workflows/guide-health.yml. Reads the public
// (slug-masked, URL-redacted) health report and decides whether any guide that
// is meant to stay alive — one with auto-refresh configured — is failing,
// overdue, missing or close to running out. Writes an issue body to
// $ALERT_BODY_FILE and `problems=<n>` / `signature=<hash>` to $GITHUB_OUTPUT.
//
// The repo is public, so the body carries public ids only, never slug names.

import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';

const base = (process.env.IPTV4U_BASE || '').replace(/\/+$/, '');
if (!base) {
  console.error('Set IPTV4U_BASE to the deployment URL.');
  process.exit(2);
}

// A renewing guide sits at ~3-4 days of schedule; under two means at least a
// couple of renewals have been missed.
const LOW_RUNWAY_MS = 48 * 60 * 60 * 1000;
const FAILURE_CODES = new Set(['AUTO_REFRESH_FAILING', 'AUTO_REFRESH_OVERDUE', 'GUIDE_MISSING', 'GUIDE_EXPIRED']);

const response = await fetch(`${base}/api/health/epg`);
if (!response.ok) {
  console.error(`Health endpoint returned HTTP ${response.status}.`);
  process.exit(1);
}
const report = await response.json();

const hours = (ms) => `${Math.round(ms / 3600000)} h`;
const problems = [];
for (const row of report.slugs || []) {
  if (!row.refresh?.configured) continue;
  const label = `Guide \`#${String(row.id || '?').slice(0, 6)}\``;
  const codes = (row.warnings || []).map((warning) => warning.code).filter((code) => FAILURE_CODES.has(code));
  const inMs = row.expiry?.inMs;
  const reasons = [];
  if (codes.length) reasons.push(codes.join(', '));
  if (Number.isFinite(inMs) && !row.expiry.expired && inMs < LOW_RUNWAY_MS) reasons.push(`only ${hours(inMs)} of schedule left`);
  if (row.refresh.lastRunStatus === 'error') {
    reasons.push(`last renewal failed${row.refresh.lastRunErrorCode ? ` (${row.refresh.lastRunErrorCode})` : ''}: ${row.refresh.lastRunError || 'no message'}`);
  }
  if (reasons.length) {
    problems.push({ key: `${row.id}:${codes.join('+')}:${row.refresh.lastRunErrorCode || ''}`, text: `- ${label}: ${reasons.join('; ')}` });
  }
}
if (report.scheduler?.observed === false) {
  problems.push({ key: 'scheduler', text: '- The hourly auto-refresh trigger does not appear to be running (check **Settings → Trigger events** on the Worker).' });
}

// Changes only when *what* is wrong changes, so the workflow comments (and
// notifies) once per new problem rather than every day.
const signature = createHash('sha256').update(problems.map((problem) => problem.key).sort().join('|')).digest('hex').slice(0, 12);

const body = problems.length
  ? [
    'The daily guide health check found a published EPG guide that may stop working in your player.',
    '',
    ...problems.map((problem) => problem.text),
    '',
    `Open the app → **Publish → Health & guides** for details (your own guide is shown by name there). Checked ${new Date().toUTCString()}.`,
    'This issue closes itself once every auto-refreshed guide is healthy again.',
    '',
    `<!-- signature: ${signature} -->`
  ].join('\n')
  : 'All auto-refreshed guides are healthy.';

if (process.env.ALERT_BODY_FILE) writeFileSync(process.env.ALERT_BODY_FILE, body);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `problems=${problems.length}\nsignature=${signature}\n`);
console.log(body);
