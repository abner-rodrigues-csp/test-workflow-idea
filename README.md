# test-workflow-idea

Prova de conceito de um pipeline CI/CD automatizado com GitFlow, deploy contínuo para staging e produção via GKE/Argo, e geração automática de releases com changelog rico.

---

## Fluxo geral

```
feature/* ou team/*
        │
        ▼
    develop  ──► Deploy Staging (GKE) ──► Auto PR: develop → main
        │                                           │
        │                                           ▼
        │                                         main ──► Auto Release (tag + changelog)
        │
   [PR bloqueado se env de homologação fechado]
```

---

## Workflows

### `deploy-sandbox.yml` — Deploy para Staging
**Trigger:** push em `develop`

Instala dependências, builda a imagem Docker e faz deploy no GKE (staging). Em caso de sucesso, dispara automaticamente o workflow de PR para main.

---

### `auto-pr-to-main.yml` — PR automático develop → main
**Trigger:** conclusão com sucesso do workflow de staging

1. Analisa todas as PRs mergeadas desde o último release
2. Detecta o tipo de bump semver (patch / minor / major) pelo título/labels das PRs
3. Atualiza a versão no `package.json` e faz commit no develop
4. Cria ou atualiza um PR `develop → main` com título `release: vX.Y.Z` e body rico contendo:
   - Lista de PRs incluídas
   - ENVs adicionadas/modificadas (extraídas dos bodies das PRs)
   - Scripts MySQL necessários

---

### `auto-release.yml` — Release automático
**Trigger:** push em `main`

Cria a tag semver e publica o GitHub Release com o changelog gerado pelo script `generate-release.mjs`. Suporta retry com backoff exponencial em caso de falha.

---

### `queue-manager-pr.yml` — Controle de ambiente de homologação
**Trigger:** abertura de PR para `develop`

Bloqueia PRs de times específicos (`command-q`, `the-keepers`) caso o ambiente de homologação correspondente não esteja aberto (verificado via labels do repositório: `aberto-command-q` / `aberto-the-keepers`).

---

### `deploy-prod-manual.yml` — Deploy manual para produção
**Trigger:** `workflow_dispatch`

Permite deploy manual para produção informando branch, tag ou SHA. Autentica no Google Cloud, builda e publica a imagem no Artifact Registry, atualiza os manifests Helm no repositório de Kubernetes (`Idea-Maker/kubernetes`) e notifica no Slack (`#ci-cd`).

---

## Script de release (`generate-release.mjs`)

Script Node.js que automatiza toda a lógica de geração de release:

| Modo | Como usar | O que faz |
|---|---|---|
| Normal | `node generate-release.mjs` | Bump version, cria tag, publica GitHub Release |
| Bump only | `--bump-only` | Só bumpa `package.json` e gera body do PR develop → main |
| Dry run | `--dry-run` | Simula tudo sem fazer alterações |

**Detecção de bump semver:**
- `BREAKING CHANGE` no body ou `!:` no título → **major**
- `feat:` no título ou label `feat`/`feature` → **minor**
- Qualquer outro → **patch**

**Extração de ENVs:** lê seções `### ENVs` e linhas no padrão `KEY=value` nos bodies das PRs.

**Extração de SQL:** captura blocos ` ```sql ``` ` e statements soltos (`SELECT`, `INSERT`, `UPDATE`, etc.) nos bodies das PRs.

---

## Secrets necessários

| Secret | Usado em |
|---|---|
| `GITHUB_TOKEN` | Todos os workflows |
| `GKE_SA_KEY_BUREAU` | Deploy staging e prod |
| `GKE_PROJECT_BUREAU` | Deploy staging e prod |
| `GKE_IMAGE` | Deploy staging e prod |
| `TOKEN_COMMIT` | Checkout do repo de kubernetes |
| `SLACK_BOT_TOKEN` | Notificações Slack |

---

## Desenvolvimento local

```bash
yarn install
yarn start
```

Para testar o script de release localmente:

```bash
DRY_RUN=true GITHUB_REPOSITORY=org/repo node .github/scripts/generate-release.mjs
```
