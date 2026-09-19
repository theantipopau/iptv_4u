#!/usr/bin/env node
// Diagnostic for the "playlist loads but the guide is empty" class of
// failure. Compares an M3U against an XMLTV guide and answers the four
// questions that actually matter to a player:
//
//   1. Is the playlist valid, and does it carry ids at all?
//   2. Is the guide valid XMLTV, and does it have channels/programmes?
//   3. Do the identifiers line up (M3U tvg-id === XMLTV <channel id>)?
//   4. Does the guide still contain programmes that haven't ended?
//
// Usage:
//   npm run diagnose -- --playlist ./playlist.m3u --epg ./guide.xml
//   npm run diagnose -- --slug my-slug --base https://iptv.example.com
//   npm run diagnose -- --all --base https://iptv.example.com
//   npm run diagnose -- --playlist https://... --epg https://... --json
//
// --all audits every published slug on a running instance (the migration check
// for an existing deployment): which guides have already expired, which are
// about to, and which have nothing scheduled to renew them.
//
// Exit codes: 0 = usable, 1 = invalid or disconnected, 2 = bad usage.
// Local paths and http(s) URLs are both accepted (gzip is handled).
// Output contains counts and identifiers only — never stream URLs, and never
// the playlist body.

import fs from 'node:fs';
import { analyzePlaylist, analyzeGuide, compareIdentifiers, assessPublication, guideFreshness } from '../shared/validate.js';
import { fetchTextMaybeGzip } from '../shared/fetch-utils.js';

const USAGE = 'Usage: npm run diagnose -- --playlist <path|url> --epg <path|url> [--json] [--now <ISO>] [--label <name>]\n       npm run diagnose -- --slug <slug> --base <url> [--json]\n       npm run diagnose -- --all --base <url> [--json]';

function parseArgs(argv) {
  const args = { json: false, playlist: null, epg: null, slug: null, base: null, now: null, label: null, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') { args.json = true; continue; }
    if (arg === '--all') { args.all = true; continue; }
    const next = argv[i + 1];
    switch (arg) {
      case '--playlist': args.playlist = next; i += 1; break;
      case '--epg': args.epg = next; i += 1; break;
      case '--slug': args.slug = next; i += 1; break;
      case '--base': args.base = next; i += 1; break;
      case '--now': args.now = next; i += 1; break;
      case '--label': args.label = next; i += 1; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}\n${USAGE}`);
    }
  }
  return args;
}

async function readSource(spec) {
  if (!spec) return null;
  if (/^https?:\/\//i.test(spec)) {
    const text = await fetchTextMaybeGzip(spec, 30000);
    return { text, origin: new URL(spec).host };
  }
  return { text: fs.readFileSync(spec, 'utf8'), origin: 'local file' };
}

function pct(numerator, denominator) {
  if (!denominator) return 'n/a';
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}

function section(title) {
  return `\n${title}\n${'-'.repeat(title.length)}`;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (args.all) {
    if (!args.base) {
      console.error('--all requires --base (e.g. --base https://iptv.example.com)');
      return 2;
    }
    return auditAll(args);
  }

  if (args.slug) {
    if (!args.base) {
      console.error('--slug requires --base (e.g. --base https://iptv.example.com)');
      return 2;
    }
    const base = args.base.replace(/\/$/, '');
    args.playlist = args.playlist || `${base}/iptv/${encodeURIComponent(args.slug)}.m3u`;
    args.epg = args.epg || `${base}/epg/${encodeURIComponent(args.slug)}.xml`;
  }

  if (!args.playlist && !args.epg) {
    console.error(USAGE);
    return 2;
  }

  const now = args.now ? Date.parse(args.now) : Date.now();
  if (Number.isNaN(now)) {
    console.error(`--now is not a valid date: ${args.now}`);
    return 2;
  }

  let playlistSource = null;
  let guideSource = null;
  try {
    [playlistSource, guideSource] = await Promise.all([readSource(args.playlist), readSource(args.epg)]);
  } catch (error) {
    console.error(`Could not read the published files: ${error.message}`);
    return 1;
  }

  const playlist = playlistSource ? analyzePlaylist(playlistSource.text) : null;
  const guide = guideSource ? analyzeGuide(guideSource.text, { now }) : null;
  const comparison = playlist && guide ? compareIdentifiers(playlist, guide) : null;
  const assessment = assessPublication({ playlist, guide, comparison, now });

  const report = {
    label: args.label || null,
    checkedAt: new Date(now).toISOString(),
    sources: {
      playlist: args.playlist ? (playlistSource?.origin || null) : null,
      epg: args.epg ? (guideSource?.origin || null) : null
    },
    playlist: playlist && {
      valid: playlist.valid,
      bytes: playlist.bytes,
      channels: playlist.channelCount,
      channelsWithTvgId: playlist.channelsWithTvgId,
      blankTvgIdCount: playlist.blankTvgIdCount,
      duplicateIds: playlist.duplicateIds.length
    },
    epg: guide && {
      validXml: guide.validXml,
      bodyKind: guide.bodyKind,
      bytes: guide.bytes,
      channels: guide.channelCount,
      programmes: guide.programmeCount,
      expiredProgrammes: guide.expiredProgrammes,
      currentOrFutureProgrammes: guide.currentOrFutureProgrammes,
      earliestStart: guide.earliestStart,
      latestStop: guide.latestStop,
      danglingProgrammeReferences: guide.danglingProgrammeReferences,
      channelsWithoutProgrammes: guide.channelsWithoutProgrammes,
      invalidProgrammeDates: guide.invalidProgrammeDates,
      freshness: guideFreshness(guide, now)
    },
    mapping: comparison && {
      matchedIds: comparison.matchedIdCount,
      matchedIdsWithProgrammes: comparison.matchedIdsWithProgrammes,
      playlistIdsWithoutEpg: comparison.playlistIdsWithoutEpg,
      guideIdsNotInPlaylist: comparison.guideIdsNotInPlaylist,
      coverage: pct(comparison.matchedIdCount, playlist?.ids?.length || 0)
    },
    errors: assessment.errors,
    warnings: assessment.warnings
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`IPTV 4U diagnostic${args.label ? ` — ${args.label}` : ''} (${report.checkedAt})`);
    if (report.sources.playlist) console.log(`playlist source: ${report.sources.playlist}`);
    if (report.sources.epg) console.log(`guide source:    ${report.sources.epg}`);

    if (playlist) {
      console.log(section('Playlist'));
      console.log(`  channels:              ${playlist.channelCount}`);
      console.log(`  channels with tvg-id:  ${playlist.channelsWithTvgId} (blank: ${playlist.blankTvgIdCount})`);
      console.log(`  duplicate tvg-ids:     ${playlist.duplicateIds.length}`);
      console.log(`  bytes:                 ${playlist.bytes}`);
    }

    if (guide) {
      console.log(section('Guide'));
      console.log(`  body kind:             ${guide.bodyKind}${guide.validXml ? '' : '  <-- NOT VALID XMLTV'}`);
      console.log(`  channels:              ${guide.channelCount}`);
      console.log(`  programmes:            ${guide.programmeCount}`);
      console.log(`  current/future:        ${guide.currentOrFutureProgrammes}   (expired: ${guide.expiredProgrammes})`);
      console.log(`  programme range:       ${guide.earliestStart || 'n/a'} -> ${guide.latestStop || 'n/a'}`);
      console.log(`  freshness:             ${guideFreshness(guide, now)}`);
      console.log(`  dangling refs:         ${guide.danglingProgrammeReferences}`);
      console.log(`  channels, no progs:    ${guide.channelsWithoutProgrammes}`);
      console.log(`  invalid dates:         ${guide.invalidProgrammeDates}`);
      console.log(`  bytes:                 ${guide.bytes}`);
    }

    if (comparison) {
      console.log(section('Identifier contract'));
      console.log(`  matched ids:           ${comparison.matchedIdCount} (coverage ${report.mapping.coverage})`);
      console.log(`  matched, with progs:   ${comparison.matchedIdsWithProgrammes}`);
      console.log(`  playlist without EPG:  ${comparison.playlistIdsWithoutEpg}`);
      console.log(`  guide ids unused:      ${comparison.guideIdsNotInPlaylist}`);
    }

    if (report.errors.length) {
      console.log(section('FAIL'));
      for (const error of report.errors) console.log(`  [${error.code}] ${error.message}`);
    }
    if (report.warnings.length) {
      console.log(section('Warnings'));
      for (const warning of report.warnings) console.log(`  [${warning.code}] ${warning.message}`);
    }
    console.log(`\nResult: ${assessment.ok ? 'usable' : 'NOT USABLE'}`);
  }

  return assessment.ok ? 0 : 1;
}

/**
 * Audit every published slug on a running instance. This is the "I already
 * have guides published" check: it answers which have expired, which are about
 * to, and which have nothing scheduled to renew them, without needing to know
 * the slugs in advance.
 * @param {{base: string, json: boolean}} args
 */
async function auditAll(args) {
  const base = args.base.replace(/\/$/, '');
  let report;
  try {
    const response = await fetchTextMaybeGzip(`${base}/api/health/epg`, 30000);
    report = JSON.parse(response);
  } catch (error) {
    console.error(`Could not read ${base}/api/health/epg: ${error.message}`);
    console.error('A deployment that predates the freshness report has no such route — check the published files directly with --slug instead.');
    return 1;
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`IPTV 4U published-guide audit (${report.checkedAt}) — overall: ${report.status}`);
    const counts = report.attention || {};
    console.log(`  expired: ${counts.expired ?? 0}   expiring soon: ${counts.expiringSoon ?? 0}   no auto-refresh: ${counts.noRefresh ?? 0}   not being run: ${counts.overdue ?? 0}`);
    if (report.scheduler) {
      const scheduler = report.scheduler;
      console.log(scheduler.observed === false
        ? `  scheduler: NOT OBSERVED (${scheduler.neverRun?.length ?? 0} enabled config(s) have never run)`
        : `  scheduler: ${scheduler.observed === true ? 'running' : 'no enabled configs'}`);
    }

    if (!report.slugs?.length) {
      console.log('\nNothing is published on this instance.');
    } else {
      const header = ['SLUG', 'STATUS', 'EXPIRY', 'CURRENT/FUTURE', 'REFRESH'];
      const rows = report.slugs.map((row) => [
        row.slug,
        row.status,
        expiryLabel(row.expiry),
        row.currentOrFutureProgrammes == null ? '?' : `${row.currentOrFutureProgrammes} of ${row.programmes ?? '?'}`,
        refreshLabel(row),
      ]);
      const widths = header.map((_, i) => Math.max(header[i].length, ...rows.map((r) => r[i].length)));
      const line = (cells) => `  ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')}`;
      console.log('');
      console.log(line(header));
      console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
      for (const row of rows) console.log(line(row));
    }

    const problems = (report.warnings || []).filter((w) => w.code !== 'SCHEDULER_NOT_OBSERVED');
    if (problems.length) {
      console.log(section('Needs attention'));
      for (const warning of problems) console.log(`  [${warning.code}] ${warning.slug || 'instance'}: ${warning.message}`);
    }
    const global = (report.warnings || []).filter((w) => w.code === 'SCHEDULER_NOT_OBSERVED');
    for (const warning of global) console.log(`\n  [${warning.code}] ${warning.message}`);
  }

  // Non-zero when there is real breakage, not merely a warning: an expired or
  // unrenewed guide is the thing this whole command exists to find.
  const broken = (report.slugs || []).some((row) => row.status === 'stale' || row.status === 'invalid' || row.status === 'missing');
  return broken ? 1 : 0;
}

function expiryLabel(expiry) {
  if (!expiry || expiry.inMs == null || !Number.isFinite(expiry.inMs)) return 'unknown';
  const abs = Math.abs(expiry.inMs);
  const days = abs / 86400000;
  const value = days >= 1 ? `${days.toFixed(1)}d` : `${Math.max(1, Math.round(abs / 3600000))}h`;
  return expiry.expired ? `expired ${value} ago` : `in ${value}`;
}

function refreshLabel(row) {
  const refresh = row.refresh || {};
  if (!refresh.configured) return 'none - will expire';
  if (refresh.paused) return 'off - will expire';
  if (row.renewal === 'overdue') return `enabled (${refresh.intervalKey}) but not running`;
  return `every ${refresh.intervalKey}${refresh.lastRunAt ? ` (last ${new Date(refresh.lastRunAt).toISOString().slice(0, 16)}Z)` : ' (never run yet)'}`;
}

const code = await main();
process.exit(code);
