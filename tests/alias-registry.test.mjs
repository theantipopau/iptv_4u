import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_ALIAS_REGISTRY, matchAliasRegistry, scoreMatch } from '../shared/core.js';

describe('CHANNEL_ALIAS_REGISTRY', () => {
  test('every entry has the required shape', () => {
    for (const entry of CHANNEL_ALIAS_REGISTRY) {
      assert.equal(typeof entry.id, 'string');
      assert.equal(typeof entry.country, 'string');
      assert.equal(typeof entry.canonicalName, 'string');
      assert.equal(typeof entry.channelNumber, 'string');
      assert.ok(Array.isArray(entry.aliases));
      assert.equal(typeof entry.platformNames, 'object');
      assert.ok(Array.isArray(entry.providerEpgIds));
    }
  });

  test('ids are unique', () => {
    const ids = CHANNEL_ALIAS_REGISTRY.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('includes the AU Fox Sports, NZ Sky Sport and ZA SuperSport fixtures from this session', () => {
    const ids = new Set(CHANNEL_ALIAS_REGISTRY.map((e) => e.id));
    for (const id of ['FoxCricket.au', 'FoxLeague.au', 'FoxFooty.au', 'FoxSportsMorePlus.au']) {
      assert.ok(ids.has(id), `missing AU fixture ${id}`);
    }
    for (const id of ['SkySport1.nz', 'SkySportPremierLeague.nz', 'ESPN.nz', 'ESPN2.nz']) {
      assert.ok(ids.has(id), `missing NZ fixture ${id}`);
    }
    for (const id of ['SuperSportRugby.za', 'SuperSportCricket.za', 'WWEChannelAfrica.za']) {
      assert.ok(ids.has(id), `missing ZA fixture ${id}`);
    }
  });
});

describe('matchAliasRegistry', () => {
  test('identifies a channel by its Kayo platform name that the public catalog has no alt_name for', () => {
    const matches = matchAliasRegistry('Kayo League', 'Kayo League', false, null);
    const top = matches.sort((a, b) => b.score - a.score)[0];
    assert.equal(top.channelId, 'FoxLeague.au');
    assert.equal(top.canMergeGuide, false, 'registry-only matches never claim a real schedule');
  });

  test('identifies a channel absent from the public catalog entirely (ESPN.nz)', () => {
    const matches = matchAliasRegistry('NZ ESPN2', 'ESPN2', false, 'NZ');
    const top = matches.sort((a, b) => b.score - a.score)[0];
    assert.equal(top.channelId, 'ESPN2.nz');
  });

  test('does not match on a bare channel number alone', () => {
    // "211" alone shares no name/alias text with any registry entry — the
    // channelNumber field is reference metadata only, never scored.
    const matches = matchAliasRegistry('211', '211', false, null);
    assert.equal(matches.length, 0);
  });

  test('SuperSport WWE resolves via its DStv platform name despite sharing only one word with the canonical name', () => {
    const matches = matchAliasRegistry('SuperSport WWE', 'SuperSport WWE', false, 'ZA');
    const top = matches.sort((a, b) => b.score - a.score)[0];
    assert.equal(top.channelId, 'WWEChannelAfrica.za');
  });

  test('country evidence still disambiguates within the registry (no ZA/AU crosstalk)', () => {
    // A ZA-hinted "SuperSport Rugby" query shouldn't spuriously prefer an
    // AU-country entry, and vice versa — sanity check that
    // applyCountryAdjustment is actually wired into the registry path.
    const zaMatches = matchAliasRegistry('SuperSport Rugby', 'SuperSport Rugby', false, 'ZA');
    assert.equal(zaMatches[0].metadata.country, 'ZA');
  });
});

describe('scoreMatch precedence sanity (registry aliases outscore incidental fuzzy overlap)', () => {
  test('an exact alias match scores at or near 1, clearly above a coincidental partial overlap', () => {
    const exact = scoreMatch('Kayo League', 'Fox Sports 502');
    // "Kayo League" isn't literally "Fox Sports 502" — the registry alias
    // list is what bridges them, not scoreMatch alone — so this checks
    // the *other* direction: the registry's own alias string ("Fox Sports
    // 502") against the same query scores very highly on its own.
    const viaAlias = scoreMatch('Fox Sports 502', 'Fox Sports 502');
    assert.equal(viaAlias, 1);
    assert.ok(exact < viaAlias);
  });
});
