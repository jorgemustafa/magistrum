# Atualização de processos e notificações

## Objetivo

Manter os processos judiciais do escritório atualizados com os andamentos mais recentes
publicados na API pública do DataJud (CNJ), de duas formas complementares: sob demanda,
por um botão no frontend, e automaticamente, por uma rotina que roda uma vez por dia.
Cada vez que um processo recebe andamentos novos, o advogado responsável é notificado, e
todo o resultado da rotina fica registrado em um histórico por processo.

## Visão geral da arquitetura

O subsistema reaproveita as peças que já existiam para a importação de processos
(`datajud.client.ts`, `CaseTimelineEvent` com de-duplicação idempotente por `sourceHash`)
e acrescenta três capacidades: sincronização incremental, histórico de execuções e
notificações por usuário.

```
                       ┌─────────────────────────────┐
  Botão "Atualizar"    │  POST /cases/:id/sync        │
  (detalhe / lista) ──▶│  POST /cases/sync            │──┐
                       └─────────────────────────────┘  │
                                                         ▼
  Agendador diário ────▶ syncAllActive ──▶  case-sync.service
  (server.ts)                                   │
                                                ▼
                        fetchDataJudCase ──▶ dedupe movimentos
                                                │
                                                ▼
                 createMany(skipDuplicates) em CaseTimelineEvent
                                                │
                         ┌──────────────────────┼───────────────────────┐
                         ▼                       ▼                       ▼
                  Case.lastSyncedAt        CaseSyncRun (histórico)   Notification
                                                                  (advogado responsável
                                                                   ou admins)
```

As camadas seguem o padrão do projeto (`docs/architecture.md`): a rota cuida do HTTP, o
service concentra as regras e o repository isola o Prisma. Os services recebem o
repository por injeção, o que permite testá-los sem banco (ver `case-sync.service.test.ts`
e `notifications.service.test.ts`).

## Modelo de dados

Três mudanças no `schema.prisma` (migration
`20260620120000_process_updates_and_notifications`):

- **`Case.lastSyncedAt`** — carimbo da última sincronização bem-sucedida. Também serve
  para ordenar a fila do job diário (os menos recentes primeiro), distribuindo melhor as
  chamadas ao DataJud.
- **`CaseSyncRun`** — uma linha por tentativa de sincronização de um processo. Guarda o
  gatilho (`MANUAL`/`SCHEDULED`), o resultado (`SUCCESS`/`NO_CHANGES`/`FAILED`), a
  quantidade de andamentos novos, a mensagem de erro (quando falha), quem disparou e os
  horários de início e fim. É o "histórico de atualizações" exibido no detalhe do processo.
- **`Notification`** — caixa de entrada por usuário. Cada notificação aponta para um
  processo (`caseId`) e carrega a quantidade de andamentos novos e o estado de leitura
  (`readAt`). Uma notificação corresponde sempre a um processo.

Os andamentos em si continuam sendo gravados em `CaseTimelineEvent`, com
`externalSource = "datajud"` e a chave única `@@unique([caseId, sourceHash])`. É essa
restrição que garante idempotência: reprocessar o mesmo processo não duplica andamentos.

## Fluxo de sincronização de um processo

1. Carrega o processo (id, CNJ, título, responsável). Sem CNJ, a sincronização é
   recusada (`CaseSyncMissingCnjError`) — só processos judiciais com CNJ são sincronizáveis.
2. Deriva o endpoint do tribunal a partir do CNJ (ver seção abaixo).
3. Chama `fetchDataJudCase({ cnjNumber, courtCode })`, que devolve o rascunho do processo
   com a lista de movimentos já mapeada.
4. De-duplica os movimentos por `sourceHash` em memória e grava com
   `createMany({ skipDuplicates: true })`. O número de linhas realmente inseridas é a
   contagem de "andamentos novos".
5. Atualiza `Case.lastSyncedAt` e registra um `CaseSyncRun`:
   - `newMovements > 0` → `SUCCESS`;
   - `newMovements == 0` → `NO_CHANGES`;
   - qualquer exceção (erro de rede, tribunal não suportado, processo não encontrado) →
     `FAILED`, com a mensagem preservada.
6. Se houve andamentos novos, gera notificações para os destinatários.

O job diário aplica esse mesmo fluxo a cada processo ativo, **isolando falhas por
processo**: um erro em um processo não interrompe os demais; ele apenas vira um
`CaseSyncRun` com status `FAILED`. O retorno agregado informa total verificado,
atualizados, sem novidade, falhas e total de andamentos novos.

## Derivação do tribunal a partir do CNJ

O DataJud expõe um índice por tribunal (`api_publica_<alias>`). Como o número CNJ já
codifica o segmento da Justiça e o tribunal, derivamos o alias sem precisar guardar nada
extra no processo (`datajud-court.ts`).

A importação consulta esse índice com `match` em `numeroProcesso`, conforme a API pública
do CNJ, e aceita apenas um resultado cujo CNJ seja idêntico ao solicitado. Uma resposta
sem esse número exato é tratada como processo não encontrado. Isso vale também para a
sincronização dos andamentos.

O CNJ tem 20 dígitos no formato `NNNNNNN DD AAAA J TR OOOO`. Usamos o dígito do segmento
(`J`, posição 14) e os dois dígitos do tribunal (`TR`, posições 15–16):

- `J = 8` (Justiça Estadual) → `tj<uf>` pelo código da UF (ex.: `26` → `tjsp`); `07` → `tjdft`.
- `J = 4` (Justiça Federal) → `trf1`..`trf6`.
- `J = 5` (Justiça do Trabalho) → `trt1`..`trt24`; `00` → `tst`.
- `J = 6` (Justiça Eleitoral) → `tre-<uf>`.
- `J = 9` (Justiça Militar Estadual) → `tjmmg`, `tjmrs`, `tjmsp`.
- `J = 3` → `stj`; `J = 7` → `stm`.

Segmentos não cobertos pela API pública (ex.: STF) resultam em
`DataJudCourtUnsupportedError`, que é registrado como falha no `CaseSyncRun` — assim o
usuário entende por que aquele processo não atualizou.

## Gatilhos

### Manual (frontend)

- **Por processo**: botão "Atualizar processo" no detalhe (`CaseDetailsPage`), exibido só
  quando o processo tem CNJ. Chama `POST /cases/:id/sync` e mostra o resultado
  ("N novos andamentos", "já está atualizado" ou a mensagem de erro).
- **Em massa**: botão "Atualizar todos" na lista de processos (`CasesPage`). Chama
  `POST /cases/sync`, que percorre todos os processos judiciais ativos com CNJ e devolve o
  resumo.

### Automático (rotina diária)

Um agendador interno e sem dependências externas
(`shared/scheduler/case-sync.scheduler.ts`) é iniciado no `server.ts` depois que a API
sobe. Ele calcula o tempo até o próximo horário configurado, dispara `syncAllActive` com
gatilho `scheduled` e se reagenda para o dia seguinte.

> Decisão de implementação: a preferência registrada era usar `node-cron`. Como o ambiente
> de desenvolvimento atual não permitiu instalar a dependência, o agendador foi escrito sem
> bibliotecas externas (também alinhado à diretriz do `AGENTS.md` de evitar novas deps). O
> comportamento — "uma vez por dia, no horário configurado" — é o mesmo. Trocar por
> `node-cron` depois é trivial: basta substituir o corpo de `startDailyCaseSyncScheduler`.

## Notificações

- **Destinatário**: o advogado responsável pelo processo (`responsibleUserId`), desde que
  ativo. Se o processo não tiver responsável ativo, a notificação vai para todos os
  usuários **admin** ativos, evitando que atualizações se percam.
- **Conteúdo**: título com o nome do processo e corpo com a quantidade de andamentos novos.
  Uma notificação por processo por execução com novidades.
- **Sino na barra direita** (`layout/NotificationsBell.tsx`): um botão de sino no topo do
  painel direito (`TodoPanel`), ao lado do controle da lista de tarefas — empilhados quando
  o painel está recolhido e lado a lado no cabeçalho quando expandido. Tem um badge com a
  contagem de não lidas (atualizado periodicamente e invalidado após sincronizações e
  leituras). Clicar abre um popover (posicionado de forma fixa, para não ser cortado pelo
  painel) com as notificações; clicar em uma linha marca como lida e redireciona para o
  processo. O popover tem "Marcar todas" e um link "Ver todas as notificações".
- **Área de notificações** (`/notifications`): página completa com as mesmas notificações
  (abas "Todas"/"Não lidas"), acessível pelo link do popover. Mesmo comportamento de clique
  (marca como lida e abre o processo).

## Histórico de atualizações

O detalhe do processo mostra o painel "Histórico de atualizações", alimentado por
`GET /cases/:id/sync-runs`. Cada linha traz data, origem (Manual/Automático), resultado
(badge), quantidade de andamentos novos e um detalhe (autor da execução manual ou a
mensagem de erro, quando falha). É por aqui que se acompanha o andamento da rotina ao
longo do trabalho.

## Vínculo de cliente (limitação do DataJud)

A API pública do DataJud retorna metadados do processo e movimentos, mas **não traz de
forma confiável o nome nem o CPF das partes**. Por isso, não há como atrelar clientes a
processos automaticamente a partir dessa fonte. O vínculo de cliente continua **manual**,
pelo fluxo de importação já existente (`ImportCasePage` / lote de importação). Se no futuro
adotarmos uma fonte que exponha as partes (por exemplo a API paga do Escavador, cujo token
já existe no `.env`), o ponto natural de extensão é o mapeamento em `datajud.client.ts` mais
uma etapa de _match_ por documento — sempre com confirmação humana antes de vincular.

## Endpoints da API

| Método | Rota | Descrição |
| --- | --- | --- |
| `POST` | `/cases/:id/sync` | Sincroniza um processo (gatilho manual). |
| `POST` | `/cases/sync` | Sincroniza todos os processos judiciais ativos com CNJ. |
| `GET` | `/cases/:id/sync-runs` | Histórico de execuções de sincronização do processo. |
| `GET` | `/notifications` | Notificações do usuário (`?status=unread` para filtrar). |
| `GET` | `/notifications/unread-count` | Contagem de não lidas. |
| `PATCH` | `/notifications/:id/read` | Marca uma notificação como lida. |
| `POST` | `/notifications/read-all` | Marca todas como lidas. |

Todas exigem autenticação. As notificações são sempre escopadas ao usuário logado.

## Regras de negócio

- Só processos **judiciais ativos com CNJ** entram na sincronização automática.
- Andamentos são idempotentes por `@@unique([caseId, sourceHash])`; reprocessar não
  duplica.
- Notificação é criada **apenas** quando há andamento novo (`newMovements > 0`).
- Toda execução — com sucesso, sem novidade ou com falha — gera um `CaseSyncRun`.
- Falha de um processo no job diário não derruba os demais.
- Notificações pertencem a um usuário; um usuário não acessa as de outro.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `DATAJUD_API_KEY` | — | Chave da API pública do DataJud (já usada na importação). |
| `ENABLE_SYNC_SCHEDULER` | `true` | `false` desliga a rotina diária (útil em testes/jobs avulsos). |
| `SYNC_DAILY_TIME` | `06:00` | Horário diário da rotina, no formato `HH:MM` (hora local do servidor). |

## Verificação

Como os artefatos nativos do Prisma/toolchain são específicos de plataforma, rode na
máquina de desenvolvimento, após aplicar a migration:

```bash
npm run prisma:generate
npm run lint
npm run typecheck
npm test
npm run build
```

Os testes de regra de negócio cobertos por este subsistema:

- `apps/api/src/tests/cases/datajud-court.test.ts` — derivação de tribunal por CNJ.
- `apps/api/src/tests/cases/case-sync.service.test.ts` — sincronização, histórico e
  notificação (com repositório mockado).
- `apps/api/src/tests/notifications/notifications.service.test.ts` — listagem, contagem
  e escopo por usuário.
