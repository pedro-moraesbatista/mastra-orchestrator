# AI Agent Orchestrator

Proof-of-concept de um orquestrador de agentes de desenvolvimento construído com **[Mastra](https://mastra.ai)** e **[OpenCode](https://opencode.ai)**.

O Mastra atua como **control plane** (workflows, retry, observabilidade, studio UI). O OpenCode atua como **worker** (coding agent, sessões, filesystem, bash, MCP). O orquestrador não recria o OpenCode — ele constrói uma camada de controle acima dele.

> A visão completa de longo prazo (API, dispatcher, queue, PR automation, integrações) está em [docs/DESIGN-VISION.md](docs/DESIGN-VISION.md).

<video src="https://raw.githubusercontent.com/pedro-moraesbatista/mastra-orchestrator/main/docs/media/mastra_orquestrator.mp4" controls width="100%"></video>

---

## Pré-requisitos

- [**Bun**](https://bun.sh) >= 1.4 (runtime TypeScript)
- [**OpenCode**](https://opencode.ai) instalado e configurado
- **OpenCode Server** rodando como servidor (ver abaixo)
- **API Key do LLM provider** (ex: [Ollama Cloud](https://ollama.com/cloud), OpenAI, etc.)

### Iniciar o OpenCode Server

O orquestrador depende de uma instância do OpenCode rodando como servidor HTTP:

```bash
opencode serve --hostname=127.0.0.1 --port=4096
```

Verifique se o servidor está acessível antes de iniciar o orquestrador:

```bash
bun run health
```

## Instalação

```bash
git clone <repo-url>
cd mastra-orchestrator
bun install
cp .env.example .env
```

Edite o arquivo `.env` com suas configurações (API keys, porta do OpenCode, etc.).

## Configuração

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `OPENCODE_HOSTNAME` | `127.0.0.1` | Hostname do servidor OpenCode |
| `OPENCODE_PORT` | `4096` | Porta do servidor OpenCode |
| `MASTRA_PORT` | `4111` | Porta do Mastra Studio |
| `MASTRA_MODEL_PROVIDER` | `ollama-cloud` | Provider do LLM |
| `MASTRA_MODEL_NAME` | `glm-5.2` | Nome do modelo LLM |
| `OLLAMA_API_KEY` | — | API key do Ollama Cloud |
| `LOG_LEVEL` | `info` | Nível de log (`debug`, `info`, `warn`, `error`, `fatal`) |
| `OPENCODE_ALLOWED_PATHS` | — | Lista de paths permitidos (separados por `;`) |
| `WORKSPACE_DIR` | `./workspace` | Diretório base do workspace |
| `WORKSPACE_ISOLATION` | `none` | Tipo de isolamento (`seatbelt`, `bwrap`, `none`) |
| `WORKSPACE_ALLOW_NETWORK` | `true` | Permitir acesso de rede no workspace |
| `WORKSPACE_REQUIRE_APPROVAL` | `false` | Exigir aprovação para execução de tools |
| `WORKSPACE_DISABLE_SHELL` | `false` | Desabilitar execução de comandos shell |
| `MCP_SERVERS` | — | JSON com configuração de MCP servers |

## Uso

### CLI

```bash
# Verificar conexão com OpenCode
bun run health

# Listar agentes disponíveis
bun run agents

# Executar tarefa via workflow de orquestração (plan → execute → review)
bun run task "Analise a estrutura deste projeto."

# Executar via decision loop (supervisor decide dinamicamente)
bun run task "Crie uma branch e implemente feature X." --loop

# Modo read-only
bun run task "Analise o projeto." --read-only

# Git worktree isolado
bun run task "Refatore o módulo X." --worktree

# Executar via agent diretamente (sem workflow)
bun run agent "Analise o projeto e explique a arquitetura."
```

### Mastra Studio

```bash
# Iniciar Mastra Studio + API (mastra dev)
bun run dev

# Iniciar Studio standalone (conecta a um servidor já rodando)
bun run studio
```

O Studio roda em `http://127.0.0.1:4111` e oferece:

- **Agents**: testar agentes individualmente com prompts
- **Workflows**: visualizar e executar workflows
- **Traces**: inspecionar cada chamada de tool, modelo e handoff
- **Metrics**: latência, custo, tokens por execução
- **Memory**: ver o contexto semântico dos agentes

---

## Arquitetura

```
CLI / Studio
     ↓
Mastra Workflows  ──→  Mastra Tools  ──→  OpenCode SDK  ──→  OpenCode Agents
     ↓                        ↓
Mastra Memory       Mastra Studio (UI + observability)
     ↓
LibSQL Storage
```

### Separação de responsabilidades

| Mastra (Control Plane) | OpenCode (Worker) |
| --- | --- |
| Workflows e steps | Coding agent (LLM reasoning) |
| Retry / timeout / suspend | Sessões de execução |
| Observabilidade (traces, logs) | Filesystem / bash / MCP tools |
| Studio UI | Code editing |
| Persistência (LibSQL) | Code review |

### Workflows

**Orchestration** — pipeline estruturado:

```
Input → Analyze → Plan → Validate → Execute (parallel com dependências) → Review → Output
```

Ciclo de replan: se o review rejeitar, o workflow refaz o plan com o feedback da rejeição (máx. 2 ciclos).

**Decision Loop** — supervisor dinâmico:

```
Input → [supervisor loop: listAgents → decide → runAgent → repeat] → Output
```

O supervisor decide a próxima ação a cada iteração, podendo executar agentes em paralelo.

### Agents

| Agente | Tools | Função |
| --- | --- | --- |
| **Planner** | `planTask`, `listAgents` | Analisa tarefa e gera plano estruturado |
| **Reviewer** | `reviewWork` | Avalia outputs dos agentes contra a tarefa original |
| **Supervisor** | `runOpencodeAgent`, `listAgents`, `mcpStatus`, `createGitWorktree` | Orquestra execução delegando para agentes |
| **Coder** | `runOpencodeAgent` | Implementa código delegando para agentes do OpenCode |

### Tools

As tools são a ponte entre Mastra e OpenCode:

- `runOpencodeAgent` — cria sessão no OpenCode, envia prompt, retorna texto
- `planTask` — delega planejamento ao agente planner
- `reviewWork` — delega revisão ao agente reviewer
- `listAgents` — lista agentes disponíveis com capabilities
- `mcpStatus` — status dos MCP servers conectados
- `createGitWorktree` — cria branch isolado via git worktree

### Retry e resiliência

O sistema implementa retry com classificação de erros (detalhado em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- **Retryable**: erros de rede, timeout, rate limit, server errors, parse errors
- **Non-retryable**: schema inválido, auth, dependência circular, agent not found
- Backoff exponencial com jitter (3 tentativas, 2s base, 30s max)
- Timeout por etapa: analyze 60s, plan 120s, execute 10min, review 120s
- Suspend/resume quando retries se esgotam

---

## Estrutura do projeto

```
src/
├── cli/index.ts              CLI entrypoint
├── config.ts                 Config centralizada (env vars)
├── opencode/
│   ├── client.ts             Conexão + health check + version
│   ├── sessions.ts           SessionManager (create, prompt, abort)
│   └── worktree.ts           Git worktree isolado
├── mastra/
│   ├── index.ts              Mastra instance (agents + workflows + server)
│   ├── agents.ts             Agentes Mastra (planner, reviewer, supervisor, coder)
│   ├── workflows.ts          Workflows (orchestration pipeline + decision loop)
│   ├── tools.ts              Tools que envolvem OpenCode SDK
│   ├── retry.ts              Retry, timeout, classificação de erros, validação
│   ├── mcp.ts                MCP client dinâmico (via env var)
│   ├── mcp/azure.ts          MCP client do Azure
│   └── workspace.ts          Workspace config (sandbox, filesystem)
└── index.ts                  barrel export

tests/
└── workflow.test.ts          29 testes (retry, timeout, validation)

docs/
├── ARCHITECTURE.md           Arquitetura do workflow implementado
└── DESIGN-VISION.md          Visão de longo prazo (futuro)
```

---

## Testes

```bash
bun run test
```

Cobertura atual (29 testes):

- `classifyError` (12 testes): rede, timeout, 429, 503, schema, circular, agent, auth, parse, permanent, retryable, unclassified
- `withRetry` (5 testes): sucesso, retry+sucesso, non-retryable, exhaust, callback
- `withTimeout` (2 testes): resolve, reject
- `validatePlan` (10 testes): correto, vazio, sem agent, sem task, self-dep, out-of-range, circular, duplicado, muitos steps, task longa

---

## Estado atual

Este é um **proof-of-concept**. O que está implementado e funcionando:

- Integração com OpenCode via SDK
- 2 workflows: orchestration (plan→execute→review) e decision-loop
- 4 agentes Mastra: planner, reviewer, supervisor, coder
- Retry com classificação de erros e backoff exponencial
- Timeout por etapa
- Suspend/resume em falhas persistentes
- Git worktree para isolamento
- Mastra Studio para observabilidade
- Persistência via LibSQL
- 29 testes unitários

O que **não** está implementado (ver [docs/DESIGN-VISION.md](docs/DESIGN-VISION.md)):

- API REST / webhooks
- Dispatcher / queue / concurrency control
- Repository registry / profiles
- Clone automático / branch naming
- Criação automática de PR
- Integração com Azure DevOps / Jira
- Dashboard / Command Center

---

## Documentação

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Arquitetura do workflow implementado (retry, timeouts, replan, suspend)
- [docs/DESIGN-VISION.md](docs/DESIGN-VISION.md) — Visão de longo prazo e roadmap completo

---

## Regra de ouro

> **Não construir um agente que sabe fazer tudo. Construir um sistema que sabe coordenar agentes que sabem fazer coisas.**