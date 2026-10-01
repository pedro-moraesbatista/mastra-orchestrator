# Mastra Orchestrator — Arquitetura do Workflow

## Visão Geral

O orquestrador usa o framework Mastra para coordenar agentes do opencode em um workflow estruturado, com retry, timeouts, observabilidade e capacidade de suspend/resume.

## Arquitetura do Workflow

```
START
  ↓
ANALYZE         — verifica conectividade opencode + lista agentes disponíveis (60s timeout)
  ↓
ORCHESTRATE     — step composto que faz o ciclo plan→validate→execute→review internamente:
  │
  │  ┌──→ PLAN (120s) — LLM gera plano estruturado
  │  │     ↓
  │  │   VALIDATE (5s) — validação determinística (ciclos, deps, duplicados)
  │  │     ↓
  │  │   EXECUTE (600s) — paralelo respeitando dependências, retry por step
  │  │     ↓ (suspend se falhas persistentes esgotam retries)
  │  │   REVIEW (120s) — LLM avalia outputs
  │  │     ↓
  │  │   ├── PASS → retorna approved
  │  │   └── REJECT → REPLAN (volta para PLAN com rejectionReason)
  │  │
  │  └── max 2 replan cycles, depois retorna rejected
  ↓
DONE
```

O `orchestrateStep` é um único step no grafo `.then()` do Mastra, mas internamente
executa o ciclo completo de plan→validate→execute→review com controle de replan.
Isso contorna a limitação do builder `.then()` que não suporta loops condicionais
nativos, mantendo observabilidade e suspend/resume funcionando.

## Diagnóstico do Timeout do `plan`

### Causa raiz

O step `plan` chamava `tools.planTask.execute()` que faz:

1. `sessions.create("mastra:planner")` → `client.session.create()` → `fetch("http://127.0.0.1:4096/...")`
2. `sessions.prompt(session.id, prompt, { agent: "planner" })` → `client.session.prompt()` → `fetch("http://127.0.0.1:4096/...")`

O `sessions.prompt()` faz uma chamada HTTP síncrona (await) para o opencode, que repassa ao LLM. Se o opencode não está rodando, ou o LLM demora, ou a conexão cai, o `fetch` fica pendente até o timeout do Node.js (default ~5 minutos para TCP).

### Evidências

- `src/opencode/sessions.ts:24-35` — `sessions.prompt()` faz `await client.session.prompt(...)` sem timeout
- `src/opencode/client.ts:13` — `createOpencodeClient({ baseUrl: url })` sem configuração de timeout
- `src/mastra/workflows.ts` (anterior) — `execTool(tools.planTask, ...)` sem timeout nem retry
- O erro `fetch failed` é do `undici` (Node fetch) quando a conexão TCP falha ou expira

### Impacto

- Workflow trava ~5 minutos sem contexto de erro
- Não há retry — falha permanente na primeira tentativa
- Studio mostra apenas `plan: fetch failed` sem detalhes

### Solução implementada

1. **Step ANALYZE** (novo) — verifica conectividade com opencode ANTES de chamar o LLM, falhando em 60s se não responder
2. **Timeout por etapa** — `withTimeout()` wrapping cada chamada de tool
3. **Retry classificado** — `withRetry()` com backoff exponencial para erros transitórios
4. **Classificação de erros** — `classifyError()` distingue retryable (rede, timeout, 429) de non-retryable (schema, auth, circular)

## Retry

### Classificação

| Tipo | Retryable? | Exemplos |
|------|-----------|----------|
| Rede | Sim | `fetch failed`, `ECONNRESET`, `ECONNREFUSED` |
| Timeout | Sim | `timeout`, `timed out`, `aborted` |
| Rate limit | Sim | `429`, `rate limit` |
| Server error | Sim | `500`, `502`, `503` |
| Parse error | Sim | `No JSON found` (LLM pode retentar) |
| Schema/Validation | Não | `invalid schema`, `validation error` |
| Agent not found | Não | `agent not found: coder` |
| Circular dependency | Não | `Circular dependency detected` |
| Auth | Não | `Unauthorized`, `invalid api key` |
| Unclassified | Não | Erros desconhecidos (fail-safe) |

### Configuração

```
maxAttempts: 3
baseDelayMs: 2000 (2s)
maxDelayMs: 30000 (30s)
backoff: exponencial + jitter (0-500ms)
```

## Replan

Quando o REVIEW rejeita o plano, o `orchestrateStep` faz um novo ciclo
`plan→validate→execute→review` com o motivo da rejeição.

```
PLAN → VALIDATE → EXECUTE → REVIEW → REJECT
  ↓ (rejectionReason passado para próximo PLAN)
PLAN → VALIDATE → EXECUTE → REVIEW → PASS → DONE
```

Limite máximo: **2 ciclos de replan** (`WORKFLOW_LIMITS.maxReplanCycles`).
Configurável via `maxReplanCycles` no input do workflow.

Após esgotar o limite, retorna `approved: false` com o resumo da última rejeição.

## Suspend/Resume

Quando um step falha repetidamente após esgotar retries (3 tentativas), o workflow suspende:

```
STEP → RETRY (3x) → FAIL → SUSPEND
```

O `suspendPayload` inclui:
- `reason`: descrição do problema
- `stepId`: qual step falhou
- `attempt`: número de tentativas
- `error`: mensagem de erro
- `taskDescription`: tarefa original

No Mastra Studio, o workflow fica com status `suspended` e pode ser retomado via `POST /workflows/orchestration/resume` quando a intervenção humana for concluída.

## Timeouts por Etapa

| Step | Timeout | Justificativa |
|------|---------|--------------|
| analyze | 60s | Apenas lista agentes, não chama LLM pesado |
| plan | 120s | LLM gera plano — pode requerer reflexão |
| validate | 5s | Validação determinística em memória |
| execute | 600s (10min) | Agentes podem fazer trabalho longo (filesystem, bash) |
| review | 120s | LLM analisa outputs — pode ser grande |

## Observabilidade

Cada step loga:
- `runId` — identificador do workflow run
- `stepId` — qual step está executando
- `attempt` — tentativa atual (para retry)
- `durationMs` — tempo de execução
- `agent` — qual agente opencode está executando
- `retryable` / `reason` — classificação do erro
- `directory` — diretório alvo

Os logs são capturados em dois sistemas:
1. **Logger em memória** (`src/logger.ts`) — buffer de 5000 entries com `getLogs()`
2. **Mastra Observability** (`@mastra/observability` com `MastraStorageExporter`) — spans/traces no `ObservabilityInMemory` storage, visíveis no Studio via `GET /observability/traces` e `GET /observability/logs`

## Proteção Contra Loops

| Limite | Valor | Descrição |
|--------|-------|-----------|
| `maxStepRetries` | 3 | Retries por step antes de suspender |
| `maxReplanCycles` | 2 | Ciclos de replan após review rejeitar |
| `maxWorkflowDuration` | 30min | Duração máxima total |
| `maxAgentIterations` | 20 | Iterações do decision-loop |
| `maxPlanSteps` | 30 | Steps máximos por plano |
| `minPlanSteps` | 1 | Steps mínimos (plano vazio = erro) |
| `maxInstructionLength` | 500 | Tamanho máximo de instrução por step |

## Arquivos

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/mastra/workflows.ts` | Definição dos workflows (orchestration + decision-loop) |
| `src/mastra/retry.ts` | Classificação de erros, retry, timeout, validação de plano |
| `src/mastra/tools.ts` | Tools que chamam opencode (runAgent, planTask, reviewWork, listAgents) |
| `src/mastra/agents.ts` | Definição dos agentes Mastra (planner, reviewer, supervisor, coder) |
| `src/mastra/index.ts` | Configuração do Mastra (storage, observability, agents, workflows) |
| `src/logger.ts` | Logger estruturado com buffer em memória |
| `tests/workflow.test.ts` | Testes de retry, timeout, validação de plano, classificação de erros |

## Testes

```
29 tests passing:
  - classifyError (12 tests): rede, timeout, 429, 503, schema, circular, agent, auth, parse, permanent, retryable, unclassified
  - withRetry (5 tests): sucesso, retry+sucesso, non-retryable, exhaust retries, callback
  - withTimeout (2 tests): resolve, reject
  - validatePlan (10 tests): correto, vazio, sem agent, sem task, self-dep, out-of-range, circular, duplicado, muitos steps, task longa
```

## Pendências

- O ciclo de replan foi resolvido: o `orchestrateStep` executa `plan→validate→execute→review`
  internamente com até 2 ciclos de replan.
- O `decision-loop` workflow tem retry/timeout/suspend mas não foi testado end-to-end
  (requer opencode rodando).
- Testes end-to-end do workflow `orchestration` requerem opencode + LLM ativo.