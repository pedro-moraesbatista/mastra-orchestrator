# Design Vision — AI Agent Orchestrator

> Este documento descreve a **visão de longo prazo** do projeto. Não reflete o estado atual da implementação, mas serve como guia arquitetural para evolução futura. Para o que está implementado hoje, consulte o [README.md](../README.md) e a [Arquitetura do Workflow](./ARCHITECTURE.md).

---

## Visão do projeto

A visão final é permitir algo como:

> "Pegue todos os tickets disponíveis, distribua entre os agentes, execute cada demanda em seu próprio ambiente, acompanhe o progresso, revise, peça minha aprovação quando necessário e gere os PRs."

A entrada poderá acontecer por:

- API;
- Webhook;
- Azure DevOps;
- Jira;
- outras fontes de tickets no futuro.

Exemplo:

```http
POST /api/tasks
```

```json
{
  "ticketId": "12345",
  "repository": "sample-app",
  "title": "Add input validation to login form",
  "description": "..."
}
```

A API não deve permanecer bloqueada esperando o agente terminar. Ela cria uma execução e retorna seu identificador:

```json
{
  "executionId": "exec_12345",
  "status": "QUEUED"
}
```

A partir desse ponto, o orquestrador controla todo o ciclo de vida.

---

# Objetivos

## Objetivo principal

Construir uma plataforma capaz de transformar uma demanda de desenvolvimento em uma execução automatizada e rastreável:

```text
Ticket
  ↓
Classificação
  ↓
Provisionamento do ambiente
  ↓
Análise
  ↓
Planejamento
  ↓
Execução por agente
  ↓
Testes
  ↓
Review
  ↓
Correção / Replanejamento
  ↓
Aprovação humana
  ↓
Pull Request
  ↓
DONE
```

## Objetivos futuros

- Receber dezenas de tickets automaticamente.
- Distribuir tickets entre agentes.
- Executar tickets em paralelo.
- Isolar completamente cada execução.
- Selecionar automaticamente o repositório correto.
- Clonar ou criar worktree do repositório.
- Criar branch seguindo o padrão do projeto.
- Executar setup específico do repositório.
- Executar testes e validações.
- Revisar o resultado.
- Replanejar quando a implementação for rejeitada.
- Solicitar aprovação humana.
- Criar Pull Requests automaticamente.
- Manter histórico completo das execuções.
- Permitir acompanhar o estado de cada ticket.
- Fazer retry de falhas técnicas transitórias.
- Permitir interromper, retomar e continuar execuções.
- Manter observabilidade sobre agentes, workflows e tarefas.

---

# Princípio arquitetural

## Mastra é o Control Plane

O Mastra é responsável por controlar a execução:

```text
Scheduling
Queue
State
Distribution
Concurrency
Retry
Timeout
Approval
Lifecycle
Observability
Workflow
```

## OpenCode é o Worker

O OpenCode é responsável pela execução de desenvolvimento:

```text
Analisar código
Planejar implementação
Editar arquivos
Executar comandos
Executar testes
Investigar problemas
Implementar solução
```

O orquestrador **não deve tentar recriar o runtime de coding agent do OpenCode**.

A separação de responsabilidades é:

```text
┌────────────────────────────────────────────┐
│              MAStra / Orchestrator         │
│                                            │
│ Queue                                      │
│ State                                      │
│ Scheduling                                 │
│ Workspace                                  │
│ Workflow                                   │
│ Retry                                      │
│ Approval                                   │
│ Review                                     │
│ PR lifecycle                               │
└──────────────────────┬─────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────┐
│                  OpenCode                  │
│                                            │
│ Coding Agent                               │
│ Sessions                                   │
│ Tools                                      │
│ MCP                                       │
│ Code reasoning                             │
│ File modifications                         │
│ Commands                                  │
└────────────────────────────────────────────┘
```

---

# Arquitetura de alto nível

```text
                    ┌──────────────────────┐
                    │ Azure DevOps / Jira  │
                    │ API / Webhook        │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │      Task API        │
                    │                      │
                    │ POST /tasks          │
                    │ GET /tasks/:id       │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │      Dispatcher      │
                    │                      │
                    │ Queue                │
                    │ Concurrency          │
                    │ Distribution         │
                    └──────────┬───────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
          Execution #1   Execution #2   Execution #3
                │              │              │
                ▼              ▼              ▼
          Workspace #1   Workspace #2   Workspace #3
                │              │              │
                ▼              ▼              ▼
             OpenCode       OpenCode       OpenCode
                │              │              │
                ▼              ▼              ▼
              Tests          Tests          Tests
                │              │              │
                ▼              ▼              ▼
              Review         Review         Review
                │              │              │
                └──────────────┼──────────────┘
                               │
                               ▼
                      Human Approval
                               │
                               ▼
                         Create PR
                               │
                               ▼
                             DONE
```

---

# Execução por ticket

Cada ticket deve gerar uma **execução independente**.

Não devemos criar um único workflow contendo:

```text
for (const ticket of tickets) {
    ...
}
```

O correto é:

```text
Ticket #101 → Execution #101
Ticket #102 → Execution #102
Ticket #103 → Execution #103
```

Isso permite que uma execução falhe sem interromper as demais.

Exemplo:

```text
#101  DONE
#102  EXECUTING
#103  FAILED
#104  WAITING_APPROVAL
#105  EXECUTING
```

O problema do #103 não deve derrubar os outros tickets.

---

# Workspace e isolamento

Cada execução deve possuir seu próprio ambiente de trabalho.

Exemplo:

```text
C:\agent-workspaces\
│
├── exec-101\
│   └── sample-app\
│       └── feature/101-login-validation
│
├── exec-102\
│   └── sample-app\
│       └── feature/102-cancellation-flow
│
└── exec-103\
    └── another-app\
        └── feature/103-bugfix
```

Mesmo que existam vários tickets para o mesmo repositório, os agentes **não devem compartilhar o mesmo diretório de trabalho**.

Exemplo:

```text
Ticket #101 → sample-app
Ticket #102 → sample-app
```

Resultado:

```text
exec-101 → workspace próprio → branch própria
exec-102 → workspace próprio → branch própria
```

Isso permite execução paralela sem conflitos de filesystem, arquivos modificados, `bin`, `obj`, `node_modules` etc.

---

# Repository Registry

O repositório não deve ser escolhido pelo agente.

O orquestrador deve possuir uma configuração central dos repositórios conhecidos.

Exemplo conceitual:

```json
{
  "repositories": {
    "sample-app": {
      "url": "git@github.com:empresa/sample-app.git",
      "defaultBranch": "master",
      "workspaceRoot": "C:/agent-workspaces",
      "branchPattern": "feature/{ticketId}-{slug}"
    },
    "another-app": {
      "url": "git@github.com:empresa/another-app.git",
      "defaultBranch": "develop",
      "workspaceRoot": "C:/agent-workspaces",
      "branchPattern": "feature/{ticketId}-{slug}"
    }
  }
}
```

O ticket informa:

```json
{
  "repository": "sample-app"
}
```

O orquestrador resolve:

```text
Repository
    ↓
Git URL
    ↓
Base branch
    ↓
Workspace
    ↓
Branch
    ↓
Setup
    ↓
Agent
```

---

# Repository Profile

Cada repositório pode possuir regras próprias.

Exemplo:

```json
{
  "name": "sample-app",
  "repository": "sample-app",
  "baseBranch": "master",

  "branch": {
    "pattern": "feature/{ticketId}-{slug}"
  },

  "setup": {
    "commands": [
      "dotnet restore",
      "npm install"
    ]
  },

  "validation": {
    "commands": [
      "dotnet test",
      "npm run build"
    ]
  },

  "pullRequest": {
    "targetBranch": "master",
    "titlePattern": "[{ticketId}] {title}"
  }
}
```

A ideia é evitar lógica espalhada pelo código como:

```text
if repository == "sample-app"
if repository == "another-app"
if repository == "..."
```

As particularidades devem ficar configuradas no perfil do repositório.

---

# Workspace Manager

O `WorkspaceManager` é responsável exclusivamente pelo ambiente de execução.

Responsabilidades:

- resolver configuração do repositório;
- clonar o repositório;
- ou utilizar Git Worktree;
- checkout da branch base;
- criar a branch da execução;
- preparar dependências;
- validar o workspace;
- limpar o ambiente após a execução;
- impedir compartilhamento acidental entre execuções.

Contrato conceitual:

```csharp
public interface IWorkspaceManager
{
    Task<Workspace> ProvisionAsync(TaskExecution execution);
    Task CleanupAsync(Workspace workspace);
}
```

Resultado esperado:

```text
Workspace
├── Path
├── Repository
├── Branch
└── BaseBranch
```

O agente recebe um workspace já preparado.

Ele não precisa executar:

```bash
git clone
git checkout
git checkout -b
```

como parte da tarefa normal.

---

# Agent Runner

O `AgentRunner` é a ponte entre o orquestrador e o OpenCode.

Responsabilidades:

- iniciar uma sessão;
- selecionar/configurar o agente;
- fornecer contexto;
- informar o workspace;
- acompanhar eventos;
- capturar resultado;
- controlar timeout;
- interromper execução quando necessário;
- retornar resultado estruturado.

Contrato conceitual:

```text
Orchestrator
     ↓
AgentRunner
     ↓
OpenCode
     ↓
Session
     ↓
Workspace
```

O OpenCode deve receber um contrato delimitado, por exemplo:

```json
{
  "task": {
    "id": "exec-123",
    "ticketId": "12345",
    "title": "Add input validation to login form",
    "description": "..."
  },
  "workspace": {
    "path": "C:/agent-workspaces/exec-123",
    "repository": "sample-app",
    "branch": "feature/12345-login-validation",
    "baseBranch": "master"
  },
  "instructions": {
    "workOnlyInsideWorkspace": true,
    "doNotChangeBranch": true,
    "doNotPush": true
  }
}
```

O princípio é:

> **Mastra controla o ambiente. OpenCode controla a implementação.**

---

# Lifecycle da execução

Cada ticket possui um estado independente.

Fluxo principal:

```text
QUEUED
   ↓
ANALYZING
   ↓
PLANNED
   ↓
EXECUTING
   ↓
TESTING
   ↓
REVIEWING
   ↓
WAITING_APPROVAL
   ↓
APPROVED
   ↓
CREATE_PR
   ↓
DONE
```

Quando o review rejeitar a implementação:

```text
REVIEWING
    ↓
REJECTED
    ↓
REPLANNING
    ↓
EXECUTING
```

Falhas técnicas seguem outro caminho:

```text
EXECUTING
    ↓
RETRYING
    ├── success → continua
    └── exhausted
            ↓
        BLOCKED / FAILED
```

**Retry técnico e replanejamento semântico são mecanismos diferentes.**

Um timeout, `fetch failed`, indisponibilidade de MCP ou erro HTTP transitório não deve automaticamente consumir um ciclo de replanejamento.

---

# Workflow de uma execução

O workflow interno de uma tarefa deve permanecer granular.

Arquitetura desejada:

```text
ANALYZE
   ↓
PLAN
   ↓
VALIDATE PLAN
   ↓
EXECUTE
   ↓
TEST
   ↓
REVIEW
   │
   ├── APPROVED ───────────────┐
   │                           │
   └── REJECTED                │
          ↓                    │
       REPLAN                  │
          ↓                    │
       EXECUTE                 │
                               ▼
                         HUMAN APPROVAL
                               │
                               ▼
                           CREATE PR
                               │
                               ▼
                              DONE
```

Evitar concentrar todo esse processo em um único `orchestrateStep` gigante.

Os passos devem permanecer observáveis e recuperáveis individualmente.

---

# Replan

O replan é uma recuperação **semântica**.

Ele deve acontecer quando o review indicar que a solução não atende ao objetivo.

O replan deve receber contexto suficiente:

```text
Original task
Previous plan
Execution results
Review
Review findings
Previous rejection
Replan cycle
```

Exemplo:

```json
{
  "replanCycle": 1,
  "previousPlan": {},
  "executionResults": [],
  "review": {
    "approved": false,
    "summary": "...",
    "findings": []
  }
}
```

O número máximo de ciclos deve ser limitado para impedir loops infinitos.

---

# Retry

Retry é destinado a falhas técnicas potencialmente transitórias.

Exemplos:

```text
HTTP 5xx
Timeout
Connection reset
Fetch failed
MCP temporariamente indisponível
```

Não devem ser automaticamente tratados como retry:

```text
Schema inválido
Plano inválido
Autorização negada
Erro determinístico
Dependência circular
Erro de validação permanente
```

A política de retry deve ser granular por operação.

Evitar:

```text
workflow inteiro → retry
```

quando somente uma operação específica falhou.

---

# Paralelismo

O sistema deve suportar dois níveis de paralelismo.

## Paralelismo entre tickets

Exemplo:

```text
30 tickets
    ↓
Concurrency = 5
    ↓
5 execuções simultâneas
```

Quando uma termina:

```text
Worker liberado
    ↓
próximo ticket da fila
```

## Paralelismo dentro de uma execução

Quando o plano possuir tarefas independentes, elas podem ser executadas em paralelo.

Exemplo:

```text
        PLAN
       /    \
      A      B
       \    /
        C
```

A e B podem executar simultaneamente.

C só inicia depois das dependências.

---

# Aprovação humana

O sistema deve possuir pontos explícitos de intervenção humana.

Exemplo:

```text
REVIEW
  ↓
approved = true
  ↓
WAITING_APPROVAL
  ↓
Humano aprova
  ↓
CREATE_PR
```

A execução não deve depender de manter uma conexão HTTP aberta.

O workflow deve poder ser suspenso e retomado.

---

# Pull Request

A criação do PR é responsabilidade do orquestrador, não do agente.

O agente:

```text
implementa
↓
testa
↓
informa resultado
```

O orquestrador:

```text
valida
↓
aprovação
↓
push
↓
create PR
↓
atualiza execução
```

Isso permite aplicar regras consistentes para todos os repositórios.

---

# Task Execution

Uma execução deve possuir dados semelhantes a:

```ts
{
  id: string
  ticketId: string
  repository: string
  workspace: string
  branch: string

  status: ExecutionStatus
  currentStep: string

  retryCount: number
  replanCount: number

  createdAt: Date
  startedAt?: Date
  finishedAt?: Date

  result?: unknown
  error?: unknown

  pullRequest?: {
    url: string
    number?: number
  }
}
```

O modelo pode evoluir, mas o princípio é que **estado da execução é persistente e consultável**.

---

# Observabilidade

O Command Center deve permitir responder rapidamente:

```text
Quantos tickets estão executando?
Qual agente está trabalhando em cada ticket?
Qual etapa está executando?
Qual ticket falhou?
Por quê?
Quantas tentativas?
Quantos replans?
Quanto tempo levou?
Qual workspace?
Qual branch?
Qual PR?
Está esperando aprovação?
```

Uma visão futura:

```text
┌─────────────────────────────────────────────────────────────┐
│                    AI COMMAND CENTER                        │
├────────┬──────────────┬───────────┬───────────┬────────────┤
│ Ticket │ Repository   │ Status    │ Agent     │ Duration   │
├────────┼──────────────┼───────────┼───────────┼────────────┤
│ #101   │ sample-app   │ EXECUTING │ Agent A   │ 04:32      │
│ #102   │ sample-app   │ REVIEWING │ Agent B   │ 07:11      │
│ #103   │ another-app  │ DONE      │ Agent C   │ 03:48      │
│ #104   │ sample-app   │ FAILED    │ Agent A   │ 01:21      │
│ #105   │ sample-app   │ APPROVAL  │ Agent D   │ 09:32      │
└────────┴──────────────┴───────────┴───────────┴────────────┘
```

---

# Repositórios e branches

Regra geral:

> Cada execução possui seu próprio workspace e sua própria branch.

Exemplo:

```text
master
 ├── feature/101-login-validation
 ├── feature/102-cancellation-flow
 └── feature/103-bugfix
```

Mesmo quando todas pertencem ao mesmo repositório:

```text
sample-app
   ├── exec-101
   ├── exec-102
   └── exec-103
```

Não compartilhar diretório de trabalho entre agentes.

No futuro, Git Worktree pode ser utilizado para reduzir custo de múltiplos clones:

```text
C:\agent-repos\
└── sample-app.git

C:\agent-workspaces\
├── exec-101\
├── exec-102\
└── exec-103\
```

O `WorkspaceManager` deve abstrair essa estratégia para que o restante do sistema não dependa de clone ou worktree diretamente.

---

# API futura

Exemplos de endpoints:

```http
POST /api/tasks
GET  /api/tasks
GET  /api/tasks/:id
POST /api/tasks/:id/approve
POST /api/tasks/:id/reject
POST /api/tasks/:id/cancel
POST /api/tasks/:id/retry
POST /api/webhooks/azure-devops
```

Exemplo:

```http
POST /api/tasks
```

```json
{
  "ticketId": "12345",
  "repository": "sample-app",
  "title": "Add input validation to login form",
  "description": "..."
}
```

Resposta:

```json
{
  "executionId": "exec-12345",
  "status": "QUEUED"
}
```

Consulta:

```http
GET /api/tasks/exec-12345
```

Resposta:

```json
{
  "id": "exec-12345",
  "ticketId": "12345",
  "status": "WAITING_APPROVAL",
  "currentStep": "REVIEWING",
  "repository": "sample-app",
  "branch": "feature/12345-login-validation",
  "tests": {
    "passed": true
  },
  "review": {
    "approved": true
  },
  "pullRequest": null
}
```

---

# O que este projeto NÃO é

Este projeto não deve evoluir para:

```text
"Outro OpenCode"
```

nem para:

```text
"Um agente gigante que faz tudo"
```

O objetivo é:

```text
                 Orquestrador
                      │
       ┌──────────────┼──────────────┐
       │              │              │
    Tickets       Workspaces      Agents
       │              │              │
       └──────────────┼──────────────┘
                      │
                  Workflows
                      │
              Review / Approval
                      │
                     PR
```

O OpenCode continua sendo o mecanismo de execução de desenvolvimento.

O Mastra coordena **quando, onde, por quê e em qual contexto** cada agente deve trabalhar.

---

# Visão final

A arquitetura desejada pode ser resumida em:

```text
                    TICKETS
                       │
                       ▼
              ┌─────────────────┐
              │     MAStra      │
              │ Control Plane   │
              └────────┬────────┘
                       │
             ┌─────────┼─────────┐
             ▼         ▼         ▼
          Queue    Scheduler   State
             │
             ▼
       Task Execution
             │
       ┌─────┴─────┐
       ▼           ▼
 Repository     Workspace
   Registry     Manager
       │           │
       └─────┬─────┘
             ▼
        Agent Runner
             │
             ▼
          OpenCode
             │
             ▼
       Implementation
             │
             ▼
           Tests
             │
             ▼
          Review
             │
       ┌─────┴─────┐
       ▼           ▼
    Replan      Approval
                   │
                   ▼
                 PR
                   │
                   ▼
                  DONE
```

A meta final é que uma pessoa possa simplesmente cadastrar uma demanda — ou dispará-la por webhook — e o sistema seja capaz de conduzir toda a execução de forma **isolada, paralela, observável, recuperável e com intervenção humana nos pontos necessários**.

---

## Regra de ouro

> **Não construir um agente que sabe fazer tudo. Construir um sistema que sabe coordenar agentes que sabem fazer coisas.**