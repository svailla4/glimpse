// repo.kpis, repo.stack, repo.packages, repo.scripts: the headline numbers and what the project is built with.
import type {ChipItem, LangRow, Rows, StatItem} from '@glimpse/catalog';
import {parseModuleId} from '../../analyze/cluster.ts';
import {repoModel} from '../../analyze/index.ts';
import {languageOf} from '../../analyze/languages.ts';
import {toolsOf} from '../../analyze/manifests.ts';
import {codeLines, declaredPackages, packagesOf, sourceLines} from '../../analyze/model.ts';
import {ecosystemOf} from '../../analyze/resolve.ts';
import type {FileEntry, Source} from '../../contracts.ts';
import {cyclesThrough, modulesIn, scopedFiles} from './deps.ts';
import {languageMix, UNCLASSIFIED} from './files.ts';
import {readHistory, scopedTotals, type Totals} from './history.ts';
import {compact, define, itemsResult, leadOf, rowsResult, scopeNote, scopeOf, type SourceOptions} from './shared.ts';

const THIRTY_DAYS = 30 * 86_400;
const MAX_LANGUAGE_CHIPS = 6;
const MAX_FRAMEWORK_CHIPS = 12;

type Category = 'framework' | 'store' | 'tool';
const chip = (label: string, category: Category = 'framework') => ({label, category});

/** Dependency name (lower case) to what it says about the stack. Curated: frameworks, data stores and build or test tools. */
const KNOWN_DEPENDENCIES: Readonly<Record<string, {label: string; category: Category}>> = {
  react: chip('React'), next: chip('Next.js'), vue: chip('Vue'), nuxt: chip('Nuxt'), svelte: chip('Svelte'), '@sveltejs/kit': chip('SvelteKit'),
  '@angular/core': chip('Angular'), lit: chip('Lit'), astro: chip('Astro'), 'solid-js': chip('Solid'), preact: chip('Preact'),
  '@remix-run/react': chip('Remix'), express: chip('Express'), fastify: chip('Fastify'), hono: chip('Hono'), koa: chip('Koa'),
  '@nestjs/core': chip('NestJS'), electron: chip('Electron'), 'react-native': chip('React Native'), expo: chip('Expo'),
  '@trpc/server': chip('tRPC'), graphql: chip('GraphQL'), '@modelcontextprotocol/sdk': chip('MCP SDK'), '@modelcontextprotocol/server': chip('MCP SDK'),
  tailwindcss: chip('Tailwind'), zod: chip('Zod'), prisma: chip('Prisma'), '@prisma/client': chip('Prisma'), 'drizzle-orm': chip('Drizzle'),
  typeorm: chip('TypeORM'), sequelize: chip('Sequelize'),
  django: chip('Django'), flask: chip('Flask'), fastapi: chip('FastAPI'), starlette: chip('Starlette'), sqlalchemy: chip('SQLAlchemy'),
  pydantic: chip('Pydantic'), celery: chip('Celery'), torch: chip('PyTorch'), tensorflow: chip('TensorFlow'), numpy: chip('NumPy'),
  pandas: chip('pandas'), langchain: chip('LangChain'), click: chip('Click'),
  rails: chip('Rails'), sinatra: chip('Sinatra'), 'laravel/framework': chip('Laravel'), 'symfony/framework-bundle': chip('Symfony'), 'slim/slim': chip('Slim'),
  'github.com/gin-gonic/gin': chip('Gin'), 'github.com/labstack/echo': chip('Echo'), 'github.com/gofiber/fiber': chip('Fiber'),
  'github.com/go-chi/chi': chip('chi'), 'gorm.io/gorm': chip('GORM'), 'github.com/spf13/cobra': chip('Cobra'), 'google.golang.org/grpc': chip('gRPC'),
  'actix-web': chip('Actix'), axum: chip('Axum'), rocket: chip('Rocket'), tokio: chip('Tokio'), serde: chip('Serde'), diesel: chip('Diesel'),
  sqlx: chip('SQLx'), clap: chip('clap'), tauri: chip('Tauri'),
  'org.springframework.boot': chip('Spring Boot'), 'io.ktor': chip('Ktor'), flutter: chip('Flutter'), vapor: chip('Vapor'),
  'microsoft.aspnetcore': chip('ASP.NET Core'), 'microsoft.entityframeworkcore': chip('EF Core'),
  pg: chip('PostgreSQL', 'store'), postgres: chip('PostgreSQL', 'store'), psycopg: chip('PostgreSQL', 'store'), psycopg2: chip('PostgreSQL', 'store'),
  asyncpg: chip('PostgreSQL', 'store'), 'github.com/jackc/pgx': chip('PostgreSQL', 'store'), 'github.com/lib/pq': chip('PostgreSQL', 'store'),
  mysql: chip('MySQL', 'store'), mysql2: chip('MySQL', 'store'), pymysql: chip('MySQL', 'store'),
  sqlite3: chip('SQLite', 'store'), 'better-sqlite3': chip('SQLite', 'store'), rusqlite: chip('SQLite', 'store'),
  mongodb: chip('MongoDB', 'store'), mongoose: chip('MongoDB', 'store'), pymongo: chip('MongoDB', 'store'),
  redis: chip('Redis', 'store'), ioredis: chip('Redis', 'store'), 'github.com/redis/go-redis': chip('Redis', 'store'),
  kafkajs: chip('Kafka', 'store'), '@elastic/elasticsearch': chip('Elasticsearch', 'store'), '@aws-sdk/client-dynamodb': chip('DynamoDB', 'store'),
  '@aws-sdk/client-s3': chip('S3', 'store'), boto3: chip('AWS SDK', 'store'),
  vite: chip('Vite', 'tool'), webpack: chip('webpack', 'tool'), esbuild: chip('esbuild', 'tool'),
  rollup: chip('Rollup', 'tool'), turbo: chip('Turborepo', 'tool'), nx: chip('Nx', 'tool'),
  vitest: chip('Vitest', 'tool'), jest: chip('Jest', 'tool'), mocha: chip('Mocha', 'tool'), '@playwright/test': chip('Playwright', 'tool'),
  playwright: chip('Playwright', 'tool'), cypress: chip('Cypress', 'tool'), pytest: chip('pytest', 'tool'), rspec: chip('RSpec', 'tool'),
  'phpunit/phpunit': chip('PHPUnit', 'tool'), junit: chip('JUnit', 'tool'), xunit: chip('xUnit', 'tool'),
  eslint: chip('ESLint', 'tool'), '@biomejs/biome': chip('Biome', 'tool'), prettier: chip('Prettier', 'tool'), ruff: chip('Ruff', 'tool'), mypy: chip('mypy', 'tool'),
};

function knownDependency(name: string) {
  const lower = name.toLowerCase();
  // Dependency names come from manifests in the repository: a package called `constructor` must not find
  // Object.prototype.constructor here.
  const known = (key: string) => (Object.hasOwn(KNOWN_DEPENDENCIES, key) ? KNOWN_DEPENDENCIES[key] : undefined);
  return known(lower)
    // Maven and NuGet names carry an artifact after the group.
    ?? known(lower.split(':')[0]!)
    ?? known(lower.split('.').slice(0, 2).join('.'));
}

/**
 * The language mix of `files` without data, prose and configuration formats: the languages someone writes code in
 * (stack chips).
 */
function codedLanguages(files: readonly FileEntry[]): LangRow[] {
  const coded = new Set<string>();
  for (const file of files) {
    const language = file.lang ? languageOf(file.path) : undefined;
    if (language && (language.kind === 'code' || language.kind === 'markup')) coded.add(language.name);
  }
  return languageMix(files).filter(row => coded.has(row.lang));
}

/** Manifest ecosystems that can declare what a file of each ecosystemOf() value imports. */
const MANIFESTS_OF: Readonly<Record<string, readonly string[]>> = {npm: ['npm', 'deno'], maven: ['maven', 'gradle']};

/**
 * The manifests a path reads (packagesOf): those under it, else the package it belongs to. Of an enclosing directory
 * with several manifests (a package.json beside a pyproject.toml), those of the languages the path is written in;
 * a Makefile serves every language. The note says which, so a table of the enclosing package is never taken for one
 * the path holds.
 */
function manifestsFor<T extends {dir: string; ecosystem: string}>(packages: readonly T[], scope: string, files: readonly FileEntry[]): {packages: T[]; note: string} {
  const found = packagesOf(packages, scope);
  if (scope === '' || !found.enclosing) return {packages: found.packages, note: scopeNote(scope)};
  if (found.packages.length === 0) return {packages: [], note: `no manifest in ${scope} or above it`};
  const ecosystems = new Set(['make']);
  for (const file of files) {
    if (sourceLines(file) === 0) continue;
    const ecosystem = ecosystemOf(file.lang);
    for (const name of MANIFESTS_OF[ecosystem] ?? [ecosystem]) ecosystems.add(name);
  }
  const matching = found.packages.filter(pkg => ecosystems.has(pkg.ecosystem));
  const chosen = matching.length > 0 ? matching : found.packages;
  const homes = [...new Set(chosen.map(pkg => pkg.dir || 'the root'))].join(', ');
  return {packages: chosen, note: `no manifest in ${scope}, so those of ${homes}`};
}

export function repoSources(options: SourceOptions): Source[] {
  const kpis = define('repo.kpis', async (ctx, ref, signal, meta) => {
    const scope = scopeOf(ref);
    const [model, history] = await Promise.all([repoModel(ctx), readHistory(ctx, signal)]);
    signal.throwIfAborted();
    // A path counts what lies under it, each number as the source of the same plate counts it for that path.
    const {files, where} = scopedFiles(model, scope, meta.name);
    const lines = files.reduce((sum, file) => sum + codeLines(file), 0);
    // Each number is the count another plate on the same page shows (decision D16): the Languages KPI the rows of
    // files.langs (its catch-all of unknown text files aside), Modules the modules deps.modules and deps.matrix cut
    // the repository into before a graph folds the smaller ones ("20 of N"), File cycles the rows of deps.cycles.
    const languages = languageMix(files).filter(row => row.lang !== UNCLASSIFIED).length;
    const modules = modulesIn(model, scope, files);
    const cycles = cyclesThrough(model, scope === '' ? undefined : files).length;
    const stats: StatItem[] = [
      {label: 'Files', value: files.length},
      {label: 'Lines', value: lines, format: 'compact'},
      {label: 'Languages', value: languages},
      {label: 'Modules', value: modules},
      // File level, and named so: a module graph marks cycles between modules, which is a different count.
      {label: 'File cycles', value: cycles, ...(cycles > 0 ? {tone: 'warn' as const} : {})},
    ];
    const warnings = [...model.warnings];
    let totals: Totals | undefined;
    if (history && scope !== '') {
      try {
        totals = await scopedTotals(ctx, {dir: parseModuleId(scope).dir, has: path => where.hasFile(path)}, signal);
      } catch (error) {
        signal.throwIfAborted();
        ctx.log(`glimpse: git log of ${scope} failed, history metrics omitted (${error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 120) : 'unknown error'})`);
      }
    } else if (history) totals = {times: history.times, authors: history.authors, partial: history.partial, warnings: history.totalWarnings};
    if (totals) {
      const now = options.now() / 1000;
      const recent = totals.times.filter(time => time > now - THIRTY_DAYS).length;
      const before = totals.times.filter(time => time <= now - THIRTY_DAYS && time > now - 2 * THIRTY_DAYS).length;
      // The same commits and authors git.log and git.authors list: one parsed history (git/log.ts). A shallow clone
      // holds only its latest commits, so the counts are lower bounds and a rise against the month before is the
      // depth of the clone, not activity: no delta is drawn (V033).
      const bound = totals.partial ? {unit: 'or more'} : {};
      stats.push(
        {label: 'Commits (30d)', value: recent, ...bound, ...(totals.partial ? {} : {delta: recent - before})},
        {label: 'Contributors', value: totals.authors.size, ...bound},
      );
      warnings.push(...totals.warnings);
    } else warnings.push('no git history: commit and contributor counts are omitted');
    // Exact below 10,000, as the viewer shows them: a rounded "4.7k" next to "4,690 files" reads as a second count.
    const shownValue = (value: number) => (Math.abs(value) < 10_000 ? value.toLocaleString('en-US') : compact(value));
    const lead = (shown: StatItem[]) =>
      leadOf(scope, shown.map(stat => `${stat.label} ${typeof stat.value === 'number' ? shownValue(stat.value) : stat.value}${stat.unit ? ` ${stat.unit}` : ''}`).join(', '));
    return itemsResult(meta, ref, stats, 'label value', lead, warnings);
  });

  const stack = define('repo.stack', async (ctx, ref, _signal, meta) => {
    const scope = scopeOf(ref);
    const model = await repoModel(ctx);
    // A path: the languages of its files, the frameworks of the manifests it reads, the tools its files reveal.
    const {files} = scopedFiles(model, scope, meta.name);
    const {packages, note} = manifestsFor(model.manifests.packages, scope, files);
    const chips: ChipItem[] = [];
    const seen = new Set<string>();
    const add = (item: ChipItem) => {
      const label = typeof item === 'string' ? item : item.label;
      if (seen.has(label)) return;
      seen.add(label);
      chips.push(item);
    };
    for (const row of codedLanguages(files).slice(0, MAX_LANGUAGE_CHIPS)) if (row.pct >= 1 || chips.length === 0) add({label: row.lang, slotKey: row.lang});
    const found = new Map<string, {label: string; category: Category; uses: number}>();
    for (const pkg of packages) {
      for (const dep of pkg.deps) {
        const known = knownDependency(dep);
        if (!known) continue;
        const entry = found.get(known.label) ?? {...known, uses: 0};
        entry.uses++;
        found.set(known.label, entry);
      }
    }
    const ranked = [...found.values()].sort((a, b) => b.uses - a.uses || (a.label < b.label ? -1 : 1));
    for (const entry of ranked.filter(item => item.category === 'framework').slice(0, MAX_FRAMEWORK_CHIPS)) add(entry.label);
    for (const entry of ranked.filter(item => item.category === 'store')) add({label: entry.label, tone: 'info'});
    for (const entry of ranked.filter(item => item.category === 'tool')) add(entry.label);
    for (const tool of scope === '' ? model.manifests.tools : toolsOf(files.map(file => file.path))) add(tool);
    const labels = (shown: ChipItem[]) => [note, shown.map(item => (typeof item === 'string' ? item : item.label)).join(', ')].filter(Boolean).join('; ');
    return itemsResult(meta, ref, chips, 'label', labels);
  });

  const packages = define('repo.packages', async (ctx, ref, _signal, meta) => {
    const scope = scopeOf(ref);
    const model = await repoModel(ctx);
    const {files} = scopedFiles(model, scope, meta.name);
    const {packages: found, note} = manifestsFor(declaredPackages(model.manifests), scope, files);
    const rows: Rows = found.map(pkg => ({name: pkg.name, ecosystem: pkg.ecosystem, version: pkg.version, dir: pkg.dir, deps: pkg.deps.length}));
    const ecosystems = new Map<string, number>();
    for (const row of rows) ecosystems.set(String(row.ecosystem), (ecosystems.get(String(row.ecosystem)) ?? 0) + 1);
    const lead = [note, [...ecosystems].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${n} ${name}`).join(', ')].filter(Boolean).join('; ');
    return rowsResult(meta, ref, rows, {by: 'dir', lead, warnings: model.manifests.warnings});
  });

  const scripts = define('repo.scripts', async (ctx, ref, _signal, meta) => {
    const scope = scopeOf(ref);
    const model = await repoModel(ctx);
    const {files} = scopedFiles(model, scope, meta.name);
    const {packages: found, note} = manifestsFor(model.manifests.packages, scope, files);
    const rows: Rows = found.flatMap(pkg => pkg.scripts.map(script => ({package: pkg.name, script: script.name, command: script.command})));
    const lead = [note, rows.slice(0, 6).map(row => String(row.script)).join(' ')].filter(Boolean).join('; ');
    return rowsResult(meta, ref, rows, {by: 'package', lead});
  });

  return [kpis, stack, packages, scripts];
}
