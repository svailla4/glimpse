// repo.kpis, repo.stack, repo.packages, repo.scripts: the headline numbers and what the project is built with.
import type {ChipItem, LangRow, Rows, StatItem} from '@glimpse/catalog';
import {repoModel, type RepoModel} from '../../analyze/index.ts';
import {languageOf} from '../../analyze/languages.ts';
import {codeLines, declaredPackages} from '../../analyze/model.ts';
import type {Source} from '../../contracts.ts';
import {languageMix, UNCLASSIFIED} from './files.ts';
import {readHistory} from './history.ts';
import {compact, define, itemsResult, rowsResult, type SourceOptions} from './shared.ts';

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

/** The language mix without data, prose and configuration formats: the languages someone writes code in (stack chips). */
function codedLanguages(model: RepoModel): LangRow[] {
  const coded = new Set<string>();
  for (const file of model.files) {
    const language = file.lang ? languageOf(file.path) : undefined;
    if (language && (language.kind === 'code' || language.kind === 'markup')) coded.add(language.name);
  }
  return languageMix(model).filter(row => coded.has(row.lang));
}

export function repoSources(options: SourceOptions): Source[] {
  const kpis = define('repo.kpis', async (ctx, ref, signal, meta) => {
    const [model, history] = await Promise.all([repoModel(ctx), readHistory(ctx, signal)]);
    signal.throwIfAborted();
    const lines = model.files.reduce((sum, file) => sum + codeLines(file), 0);
    // Each number is the count another plate on the same page shows (decision D16): the Languages KPI the rows of
    // files.langs (its catch-all of unknown text files aside), Modules the modules deps.modules and deps.matrix cut
    // the repository into before a graph folds the smaller ones ("20 of N"), File cycles the rows of deps.cycles.
    const languages = languageMix(model).filter(row => row.lang !== UNCLASSIFIED).length;
    const stats: StatItem[] = [
      {label: 'Files', value: model.files.length},
      {label: 'Lines', value: lines, format: 'compact'},
      {label: 'Languages', value: languages},
      {label: 'Modules', value: model.modules},
      // File level, and named so: a module graph marks cycles between modules, which is a different count.
      {label: 'File cycles', value: model.cycles.length, ...(model.cycles.length > 0 ? {tone: 'warn' as const} : {})},
    ];
    const warnings = [...model.warnings];
    if (history) {
      const now = options.now() / 1000;
      const recent = history.times.filter(time => time > now - THIRTY_DAYS).length;
      const before = history.times.filter(time => time <= now - THIRTY_DAYS && time > now - 2 * THIRTY_DAYS).length;
      // The same commits and authors git.log and git.authors list: one parsed history (git/log.ts). A shallow clone
      // holds only its latest commits, so the counts are lower bounds and a rise against the month before is the
      // depth of the clone, not activity: no delta is drawn (V033).
      const bound = history.partial ? {unit: 'or more'} : {};
      stats.push(
        {label: 'Commits (30d)', value: recent, ...bound, ...(history.partial ? {} : {delta: recent - before})},
        {label: 'Contributors', value: history.authors.size, ...bound},
      );
      warnings.push(...history.totalWarnings);
    } else warnings.push('no git history: commit and contributor counts are omitted');
    // Exact below 10,000, as the viewer shows them: a rounded "4.7k" next to "4,690 files" reads as a second count.
    const shownValue = (value: number) => (Math.abs(value) < 10_000 ? value.toLocaleString('en-US') : compact(value));
    const lead = (shown: StatItem[]) =>
      shown.map(stat => `${stat.label} ${typeof stat.value === 'number' ? shownValue(stat.value) : stat.value}${stat.unit ? ` ${stat.unit}` : ''}`).join(', ');
    return itemsResult(meta, ref, stats, 'label value', lead, warnings);
  });

  const stack = define('repo.stack', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const chips: ChipItem[] = [];
    const seen = new Set<string>();
    const add = (item: ChipItem) => {
      const label = typeof item === 'string' ? item : item.label;
      if (seen.has(label)) return;
      seen.add(label);
      chips.push(item);
    };
    for (const row of codedLanguages(model).slice(0, MAX_LANGUAGE_CHIPS)) if (row.pct >= 1 || chips.length === 0) add({label: row.lang, slotKey: row.lang});
    const found = new Map<string, {label: string; category: Category; uses: number}>();
    for (const pkg of model.manifests.packages) {
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
    for (const tool of model.manifests.tools) add(tool);
    return itemsResult(meta, ref, chips, 'label', shown => shown.map(item => (typeof item === 'string' ? item : item.label)).join(', '));
  });

  const packages = define('repo.packages', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const rows: Rows = declaredPackages(model.manifests)
      .map(pkg => ({name: pkg.name, ecosystem: pkg.ecosystem, version: pkg.version, dir: pkg.dir, deps: pkg.deps.length}));
    const ecosystems = new Map<string, number>();
    for (const row of rows) ecosystems.set(String(row.ecosystem), (ecosystems.get(String(row.ecosystem)) ?? 0) + 1);
    const lead = [...ecosystems].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${n} ${name}`).join(', ');
    return rowsResult(meta, ref, rows, {by: 'dir', lead, warnings: model.manifests.warnings});
  });

  const scripts = define('repo.scripts', async (ctx, ref, _signal, meta) => {
    const model = await repoModel(ctx);
    const rows: Rows = model.manifests.packages.flatMap(pkg => pkg.scripts.map(script => ({package: pkg.name, script: script.name, command: script.command})));
    const lead = rows.slice(0, 6).map(row => String(row.script)).join(' ');
    return rowsResult(meta, ref, rows, {by: 'package', lead});
  });

  return [kpis, stack, packages, scripts];
}
