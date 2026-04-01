#!/usr/bin/env node
/* eslint-disable */

/**
 * generate-release.mjs
 *
 * Coleta as PRs mergeadas desde o último release, extrai ENVs e SQL
 * dos bodies, detecta o bump de versão (semver) e cria o GitHub Release
 * com um body rico — mesma lógica do idea-release-cli, mas automatizado.
 */

import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
if (DRY_RUN) console.log('🧪 DRY RUN — nenhuma alteração será feita no repositório.\n');

const BUMP_ONLY = process.argv.includes('--bump-only') || process.env.BUMP_ONLY === 'true';
if (BUMP_ONLY) console.log('🔖 BUMP ONLY — apenas versão será bumped no develop.\n');

// ── helpers ───────────────────────────────────────────────────────────────────

function exec(cmd) {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gh(...args) {
  const escaped = args
    .map(a => `'${String(a).replace(/'/g, "'\\''")}'`)
    .join(' ');
  return execSync(`gh ${escaped}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function ghJson(...args) {
  return JSON.parse(gh(...args));
}

// ── parsers (port de idea-release-cli) ───────────────────────────────────────

// Palavras que indicam "sem valor" nos bodies das PRs
const PLACEHOLDERS = new Set([
  'nenhum',
  'nenhuma',
  'nenhum.',
  'nenhuma.',
  'n/a',
  'na',
  'none',
  'vazio',
  '-',
]);

function isPlaceholder(s) {
  return PLACEHOLDERS.has(String(s).trim().toLowerCase());
}

function parseEnvsFromBody(body) {
  const envs = [];

  // 1) .env style fora de seções estruturadas (evita sobreposição com o parser de bullets)
  //    Remove as seções ### ENVs antes de aplicar o regex para não duplicar.
  const bodyWithoutEnvSection = body.replace(
    /### envs[\s\S]*?(?=\n###|$)/gi,
    '',
  );
  const reEnv = /^(?:\s*export\s+)?([A-Z0-9_.]+)\s*=\s*"?([^"\r\n]+)"?\s*$/gim;
  for (const m of bodyWithoutEnvSection.matchAll(reEnv)) {
    if (!isPlaceholder(m[1]) && !isPlaceholder(m[2])) {
      envs.push({ key: m[1], value: m[2] });
    }
  }

  // 2) Bullets dentro de seção ### ENVs
  let inside = false;
  let pending = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\r/g, '');
    if (!inside && line.toLowerCase().startsWith('### envs')) {
      inside = true;
      pending = null;
      continue;
    }
    if (inside && /^### /.test(line)) {
      inside = false;
      pending = null;
      break;
    }
    if (!inside) {
      continue;
    }

    const trimmed = line.trim();

    // Linha "- Valor: ..." ou "* Valor: ..." resolve a chave pendente
    if (pending && /^\s*[-*]\s*Valor:/i.test(line)) {
      const v = line
        .split(':')
        .slice(1)
        .join(':')
        .trim()
        .replace(/^["']+|["']+$/g, '');
      if (!isPlaceholder(v)) {
        envs.push({ key: pending, value: v });
      }
      pending = null;
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      pending = null; // nova bullet reseta o pending anterior
      let t = trimmed.slice(2).trim();
      if (t.startsWith('`') && t.endsWith('`')) {
        t = t.slice(1, -1);
      }
      if (isPlaceholder(t)) {
        continue;
      }

      if (/^[A-Za-z0-9_.]+\s*=/.test(t)) {
        // KEY=value inline
        const eqIdx = t.indexOf('=');
        const k = t.slice(0, eqIdx).trim();
        const v = t
          .slice(eqIdx + 1)
          .trim()
          .replace(/^["']+|["']+$/g, '');
        if (!isPlaceholder(k) && !isPlaceholder(v)) {
          envs.push({ key: k, value: v });
        }
      } else if (/^[A-Za-z0-9_]+$/.test(t)) {
        // KEY sem valor inline — aguarda "- Valor:" na próxima linha
        pending = t;
      }
    }
  }

  const seen = new Set();
  return envs.filter(({ key, value }) => {
    const id = `${key}=${value}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function parseSqlFromBody(body) {
  const blocks = [];

  // 1) Extrai blocos ```sql ... ``` e remove-os do body para evitar duplicação na etapa 2
  const strippedBody = body.replace(
    /```sql\s*([\s\S]*?)\s*```/gi,
    (_, content) => {
      const b = content.trim();
      if (b) {
        blocks.push(b);
      }
      return ''; // remove do body para o regex de linhas não pegar de novo
    },
  );

  // 2) SQL fora de blocos (statements soltos no texto)
  const looseLines = [];
  const reLine =
    /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|RENAME)\b.*$/gim;
  for (const m of strippedBody.matchAll(reLine)) {
    looseLines.push(m[0].trim());
  }

  return [...new Set([...blocks, ...looseLines])];
}

// ── semver ────────────────────────────────────────────────────────────────────

function parseSemver(s) {
  const m = String(s || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function bumpVersion(ver, kind) {
  if (kind === 'major') {
    return { major: ver.major + 1, minor: 0, patch: 0 };
  }
  if (kind === 'minor') {
    return { major: ver.major, minor: ver.minor + 1, patch: 0 };
  }
  return { major: ver.major, minor: ver.minor, patch: ver.patch + 1 };
}

function fmtVer(v) {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

// ── git / github ──────────────────────────────────────────────────────────────

function getLastTag() {
  try {
    const tags = exec("git tag --list 'v*' --sort=-v:refname")
      .split('\n')
      .filter(Boolean);
    return tags[0] || null;
  } catch {
    return null;
  }
}

function collectPrNumbers(repo, lastTag) {
  const safeTag = lastTag ? lastTag.replace(/[^a-zA-Z0-9._-]/g, '') : null;
  const range = safeTag ? `${safeTag}..HEAD` : 'HEAD';
  let logOutput = '';
  try {
    logOutput = exec(`git log ${range} --format="%H %s"`);
  } catch {
    return [];
  }
  if (!logOutput) {
    return [];
  }

  const commits = logOutput
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const spaceIdx = line.indexOf(' ');
      return { sha: line.slice(0, spaceIdx), msg: line.slice(spaceIdx + 1) };
    });

  const prNums = new Set();

  // PR numbers referenciados nas mensagens de commit
  for (const { msg } of commits) {
    for (const m of msg.matchAll(/#(\d+)/g)) {
      prNums.add(Number(m[1]));
    }
  }

  // PRs via GitHub API (associação commit → PR)
  for (const { sha } of commits.slice(0, 100)) {
    try {
      const pulls = ghJson(
        'api',
        `repos/${repo}/commits/${sha}/pulls`,
        '-H',
        'Accept: application/vnd.github+json',
      );
      for (const p of pulls || []) {
        prNums.add(Number(p.number));
      }
    } catch {}
  }

  return [...prNums].sort((a, b) => a - b);
}

function detectBump(prs) {
  let hasBreaking = false;
  let hasFeat = false;
  for (const pr of prs) {
    const title = pr.title || '';
    const body = pr.body || '';
    const labels = pr.labels || [];
    if (/\bbreaking change\b/i.test(body) || /!\s*:/.test(title)) {
      hasBreaking = true;
    }
    if (
      /^feat(\(|:|!)/i.test(title) ||
      labels.some(l => /feat|feature/i.test(l.name))
    ) {
      hasFeat = true;
    }
  }
  return hasBreaking ? 'major' : hasFeat ? 'minor' : 'patch';
}

function generateBody(prs, envsByKey, sqlByPr) {
  const lines = [];

  lines.push('### O que está sendo implementado?\n');
  if (prs.length === 0) {
    lines.push('- N/A\n');
  } else {
    for (const pr of prs) {
      lines.push(`- #${pr.number} — ${pr.title}`);
    }
    lines.push('');
  }

  lines.push('\n### ENVs adicionadas ou modificadas\n');
  const keys = [...envsByKey.keys()].sort();
  if (keys.length === 0) {
    lines.push('- N/A\n');
  } else {
    for (const k of keys) {
      const vals = [...(envsByKey.get(k) || [])];
      if (!vals.length || (vals.length === 1 && vals[0] === '')) {
        lines.push(`- ${k}`);
      } else {
        for (const v of vals) {
          if (/[^A-Za-z0-9._:/?\-=]/.test(v)) {
            lines.push(`- ${k}`);
            lines.push(`  - Valor: ${v}`);
          } else {
            lines.push(`- ${k}="${v}"`);
          }
        }
      }
    }
    lines.push('');
  }

  lines.push('\n### MYSQL\n');
  const prWithSql = [...sqlByPr.keys()].sort((a, b) => a - b);
  if (prWithSql.length === 0) {
    lines.push('- N/A');
  } else {
    for (const n of prWithSql) {
      lines.push(`- (#${n})\n`);
      lines.push('```sql');
      for (const chunk of sqlByPr.get(n) || []) {
        lines.push(chunk);
      }
      lines.push('```\n');
    }
  }

  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error('GITHUB_REPOSITORY not set');
  }

  const lastTag = getLastTag();
  console.log(`📌 Last tag: ${lastTag || '(none — first release)'}`);

  const currentVer = (lastTag && parseSemver(lastTag)) || {
    major: 0,
    minor: 0,
    patch: 0,
  };

  // Coletar PRs desde o último release
  console.log('\n🔎 Coletando PRs...');
  const prNums = collectPrNumbers(repo, lastTag);

  const prs = [];
  for (const n of prNums) {
    try {
      const pr = ghJson(
        'pr',
        'view',
        String(n),
        '--repo',
        repo,
        '--json',
        'number,title,body,labels',
      );
      // Ignora PRs de release anteriores (release, release:, release: develop → main, etc.)
      if (!/^release(?=\s|:|$)/i.test(pr.title || '')) {
        prs.push(pr);
      }
    } catch {}
  }

  if (prs.length === 0) {
    console.log(
      '⚠️  Nenhuma PR nova encontrada desde o último release. Abortando.',
    );
    process.exit(0);
  }

  console.log(
    `✅ ${prs.length} PR(s): ${prs.map(p => `#${p.number}`).join(', ')}`,
  );

  // Detectar bump
  const bumpKind = detectBump(prs);
  const nextVer = bumpVersion(currentVer, bumpKind);
  const nextTag = fmtVer(nextVer);
  console.log(`\n📦 Bump: ${bumpKind.toUpperCase()} → ${nextTag}`);

  // ── bump-only mode ────────────────────────────────────────────────────────
  if (BUMP_ONLY) {
    const pkgPath = resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.version = `${nextVer.major}.${nextVer.minor}.${nextVer.patch}`;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
    console.log(`📝 package.json → ${pkg.version}`);

    exec('git config user.name "github-actions[bot]"');
    exec('git config user.email "github-actions[bot]@users.noreply.github.com"');
    exec('git add package.json');

    // Extrair ENVs e SQL e gerar body rico para o PR develop → main
    const envsByKey = new Map();
    const sqlByPr = new Map();
    for (const pr of prs) {
      const body = pr.body || '';
      for (const { key, value } of parseEnvsFromBody(body)) {
        if (!envsByKey.has(key)) envsByKey.set(key, new Set());
        envsByKey.get(key).add(value ?? '');
      }
      const sql = parseSqlFromBody(body);
      if (sql.length) sqlByPr.set(pr.number, sql);
    }

    const releaseDetails = generateBody(prs, envsByKey, sqlByPr);
    const prBody = [
      '## Release para Produção\n',
      '> PR gerado automaticamente após deploy em staging com sucesso.\n',
      '---\n',
      releaseDetails,
    ].join('\n');
    writeFileSync('/tmp/pr-body.md', prBody, 'utf-8');
    console.log('📋 PR body gerado em /tmp/pr-body.md');

    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) appendFileSync(outputFile, `next_tag=${nextTag}\n`);
    console.log(`\n✅ next_tag=${nextTag}`);
    process.exit(0);
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Checar se a tag já existe
  let tagExists = false;
  try {
    exec(`git rev-parse ${nextTag} -- 2>/dev/null`);
    tagExists = true;
    console.log(
      `⚠️  Tag ${nextTag} já existe. Continuando com publicação do release...`,
    );
  } catch {}

  // Extrair ENVs e SQL das PRs
  const envsByKey = new Map();
  const sqlByPr = new Map();
  for (const pr of prs) {
    const body = pr.body || '';
    for (const { key, value } of parseEnvsFromBody(body)) {
      if (!envsByKey.has(key)) {
        envsByKey.set(key, new Set());
      }
      envsByKey.get(key).add(value ?? '');
    }
    const sql = parseSqlFromBody(body);
    if (sql.length) {
      sqlByPr.set(pr.number, sql);
    }
  }

  // Gerar body do release
  const releaseBody = generateBody(prs, envsByKey, sqlByPr);

  // Atualizar versão no package.json
  const pkgPath = resolve(process.cwd(), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.version = `${nextVer.major}.${nextVer.minor}.${nextVer.patch}`;
  console.log(`\n📝 package.json → ${pkg.version}`);

  if (DRY_RUN) {
    console.log('\n─────────────────────────────────────────');
    console.log('📋 RELEASE BODY PREVIEW:\n');
    console.log(releaseBody);
    console.log('─────────────────────────────────────────');
    console.log('\n✅ Dry run concluído. Nenhuma alteração foi feita.');
    return;
  }

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');

  // Commitar e subir bump de versão (apenas se tag não existe)
  if (!tagExists) {
    exec('git config user.name "github-actions[bot]"');
    exec(
      'git config user.email "github-actions[bot]@users.noreply.github.com"',
    );
    exec('git add package.json');

    // Verificar se há mudanças antes de fazer commit
    try {
      exec('git diff --quiet --exit-code --staged');
      console.log('⚠️  Nenhuma alteração staged. Pulando commit.');
    } catch {
      // Há mudanças staged, pode fazer commit
      exec(`git commit -m "[CI-CD] chore(release): ${nextTag} [skip ci]"`);
      try {
        exec('git push origin HEAD:main');
        console.log('⬆️  Version bump pushed');
      } catch (pushErr) {
        console.warn('⚠️  Não foi possível fazer push do version bump (branch protection ativa). Continuando com a criação da tag e release...');
      }
    }

    // Criar e subir tag
    exec(`git tag ${nextTag}`);
    exec(`git push origin ${nextTag}`);
    console.log(`🏷️  Tag ${nextTag} pushed`);
  } else {
    console.log(
      `⏭️  Pulando criação de tag ${nextTag} (já existe). Continuando com publicação do release...`,
    );
  }

  // Criar GitHub Release com body rico com retry logic
  const bodyFile = '/tmp/release-body.md';
  writeFileSync(bodyFile, releaseBody, 'utf-8');

  async function publishRelease() {
    const maxRetries = 3;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
      try {
        console.log(
          `\n📤 Tentando publicar release ${nextTag}... (tentativa ${attempt + 1}/${maxRetries})`,
        );

        // Tentar deletar release existente se tag já existe
        if (tagExists && attempt > 0) {
          try {
            gh('release', 'delete', nextTag, '--yes', '--repo', repo);
            console.log(`🗑️  Release anterior ${nextTag} deletado.`);
          } catch {
            // Ignorar erro se release não existe
          }
        }

        gh(
          'release',
          'create',
          nextTag,
          '--repo',
          repo,
          '--title',
          `Release ${nextTag}`,
          '--notes-file',
          bodyFile,
        );

        console.log(`\n✅ Release ${nextTag} criado com sucesso!`);
        return true;
      } catch (err) {
        lastError = err;
        attempt += 1;
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // exponential backoff
          console.log(
            `⚠️  Erro ao publicar release. Aguardando ${delay}ms antes de re-tentar...`,
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error(
      `❌ Falha ao publicar release após ${maxRetries} tentativas:`,
      lastError?.message || lastError,
    );
    process.exit(1);
  }

  await publishRelease();
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
