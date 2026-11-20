import {SOURCE_BY_NAME, type SourceMeta} from '@glimpse/catalog';
import {describe, expect, it} from 'vitest';
import {SourceError} from '../../src/contracts.ts';
import {cutRows, dayOf, isoOf, pathOf, plural, requireGit, round, sinceOf, summarize, topOf} from '../../src/sources/git/args.ts';
import {FIXTURE_NOW} from '../git/context.ts';

const ref = (args: Record<string, string>) => ({source: 'git.churn', args});
const codeOf = (run: () => unknown): string | undefined => {
  try { run(); } catch (error) { return error instanceof SourceError ? error.code : `not a SourceError: ${String(error)}`; }
  return undefined;
};

describe('ref arguments', () => {
  it('top= is a positive whole number', () => {
    expect(topOf(ref({}))).toBeUndefined();
    expect(topOf(ref({top: '1'}))).toBe(1);
    expect(topOf(ref({top: '250'}))).toBe(250);
    for (const bad of ['0', '-1', '1.5', 'ten', '', ' 5', '5 ', '1e3', '0x10', '9999999999', '٣']) expect(codeOf(() => topOf(ref({top: bad}))), bad).toBe('E_ARGS');
  });

  it('since= is a number of days, weeks, months or years back from the start of today (UTC)', () => {
    const midnight = Date.parse('2026-11-20T00:00:00Z') / 1000;
    expect(sinceOf(ref({}), FIXTURE_NOW)).toBeUndefined();
    expect(sinceOf(ref({since: '90d'}), FIXTURE_NOW)).toEqual({cutoff: midnight - 90 * 86_400, label: '90d'});
    expect(sinceOf(ref({since: '12w'}), FIXTURE_NOW)!.cutoff).toBe(midnight - 84 * 86_400);
    expect(sinceOf(ref({since: '6m'}), FIXTURE_NOW)!.cutoff).toBe(midnight - 180 * 86_400);
    expect(sinceOf(ref({since: '2y'}), FIXTURE_NOW)!.cutoff).toBe(midnight - 730 * 86_400);
    // the default window of a source applies only when the ref has none
    expect(sinceOf(ref({}), FIXTURE_NOW, 365)).toEqual({cutoff: midnight - 365 * 86_400, label: '365d'});
    expect(sinceOf(ref({since: '1d'}), FIXTURE_NOW, 365)!.cutoff).toBe(midnight - 86_400);
    // the same ref gives the same window all day
    expect(sinceOf(ref({since: '7d'}), FIXTURE_NOW + 3_600_000)).toEqual(sinceOf(ref({since: '7d'}), FIXTURE_NOW));
    for (const bad of ['', '90', 'd', '0d', '-3d', '3 d', '3h', '1.5w', '2026-01-01', 'yesterday', '--since=1d', '999999d']) {
      expect(codeOf(() => sinceOf(ref({since: bad}), FIXTURE_NOW)), bad).toBe('E_ARGS');
    }
  });

  it('a path target is normalised, and anything outside the repository is E_TARGET', () => {
    expect(pathOf(undefined)).toBe('');
    expect(pathOf('./src/auth/')).toBe('src/auth');
    expect(pathOf('src/a b.ts#L3')).toBe('src/a b.ts');
    for (const bad of ['../x', '/etc', 'a/../../b']) expect(codeOf(() => pathOf(bad)), bad).toBe('E_TARGET');
  });

  it('error messages quote, and shorten, what was written', () => {
    const error = (() => { try { topOf(ref({top: `1${'0'.repeat(200)}"\n`})); } catch (e) { return e as SourceError; } })();
    expect(error!.message.length).toBeLessThan(120);
    expect(error!.message).not.toContain('\n');
  });

  it('requireGit answers E_NO_GIT without a repository', () => {
    expect(codeOf(() => requireGit({git: null} as never))).toBe('E_NO_GIT');
    expect(requireGit({git: {shallow: false}} as never)).toEqual({shallow: false});
  });
});

describe('formatting helpers', () => {
  it('dates are UTC, numbers are rounded, summaries are one clipped line', () => {
    expect(dayOf(Date.parse('2026-11-04T23:59:59Z') / 1000)).toBe('2026-11-04');
    expect(isoOf(Date.parse('2026-11-04T12:00:00Z') / 1000)).toBe('2026-11-04T12:00:00Z');
    expect(round(66.666, 1)).toBe(66.7);
    expect(round(0.375, 2)).toBe(0.38);
    expect(plural(1, 'commit')).toBe('1 commit');
    expect(plural(0, 'commit')).toBe('0 commits');
    expect(summarize('a\n  b\tc ')).toBe('a b c');
    expect(summarize('x'.repeat(500))).toHaveLength(160);
    expect(summarize('x'.repeat(500)).endsWith('…')).toBe(true);
  });
});

describe('cutRows', () => {
  const churn = SOURCE_BY_NAME.get('git.churn')!;
  const authors = SOURCE_BY_NAME.get('git.authors')!;
  const rows = (count: number) => Array.from({length: count}, (_, i) => ({path: `f${i}.ts`, commits: count - i}));

  it('returns everything when it fits, with the fields of the source in the summary', () => {
    const result = cutRows(churn, rows(3), {by: 'commits', detail: shown => `top ${shown[0]!.path}`});
    expect(result.data).toHaveLength(3);
    expect(result).toMatchObject({total: 3, fields: churn.fields, roles: churn.roles, summary: '3 rows; fields path commits authors owner ownership last; top f0.ts'});
    expect(result.truncated).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(result.allRows).toEqual(result.data);
    expect(cutRows(churn, rows(1)).summary).toBe('1 row; fields path commits authors owner ownership last');
    expect(cutRows(churn, []).summary).toBe('0 rows; fields path commits authors owner ownership last');
  });

  it('cuts to the budget and keeps the full set page-able', () => {
    const result = cutRows(churn, rows(800), {by: 'commits'});
    expect(result.data).toHaveLength(churn.budget);
    expect(result.data[0]).toEqual({path: 'f0.ts', commits: 800});
    expect(result.total).toBe(800);
    expect(result.allRows).toHaveLength(800);
    expect(result.truncated).toEqual({total: 800, returned: 500, strategy: 'topN', by: 'commits'});
    expect(result.summary.startsWith('500/800 rows; fields path')).toBe(true);
  });

  it('top= caps the reachable rows: nothing beyond it is page-able', () => {
    const small = cutRows(churn, rows(800), {top: 15, by: 'commits'});
    expect(small.data).toHaveLength(15);
    expect(small.total).toBe(15);
    expect(small.allRows).toHaveLength(15);
    expect(small.truncated).toEqual({total: 800, returned: 15, strategy: 'topN', by: 'commits'});
    expect(small.summary.startsWith('15/800 rows')).toBe(true);
    // a top above the budget: the budget is bound, the rest of the top is page-able
    const large = cutRows(churn, rows(800), {top: 600});
    expect(large.data).toHaveLength(500);
    expect(large.total).toBe(600);
    expect(large.allRows).toHaveLength(600);
    expect(large.truncated).toMatchObject({total: 800, returned: 500});
    // a top above everything changes nothing
    expect(cutRows(churn, rows(3), {top: 50}).truncated).toBeUndefined();
  });

  it('sources that are not page-able keep no second copy; warnings pass through', () => {
    const result = cutRows(authors, rows(300), {warnings: ['shallow clone: history is incomplete']});
    expect(result.data).toHaveLength(authors.budget);
    expect(result.allRows).toBeUndefined();
    expect(result.warnings).toEqual(['shallow clone: history is incomplete']);
  });

  it('time series keep the latest rows', () => {
    const activity = SOURCE_BY_NAME.get('git.activity')!;
    const days = Array.from({length: 450}, (_, i) => ({date: dayOf(1_700_000_000 + i * 86_400), commits: 1}));
    const result = cutRows(activity, days, {strategy: 'window', by: 'date'});
    expect(result.data).toHaveLength(activity.budget);
    expect(result.data.at(-1)).toEqual(days.at(-1));
    expect(result.truncated).toEqual({total: 450, returned: 400, strategy: 'window', by: 'date'});
    expect(cutRows(activity, days, {strategy: 'window', top: 7}).data).toEqual(days.slice(-7));
    // rows the source dropped itself count towards "of"
    expect(cutRows(activity, days.slice(-10), {strategy: 'bucket', of: 450}).truncated).toEqual({total: 450, returned: 10, strategy: 'bucket'});
  });

  it('summaries never exceed 160 characters', () => {
    const meta: SourceMeta = {...churn, fields: Array.from({length: 40}, (_, i) => ({key: `field_number_${i}`}))};
    expect(cutRows(meta, rows(2), {detail: () => 'detail '.repeat(40)}).summary.length).toBeLessThanOrEqual(160);
  });
});
