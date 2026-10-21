# Diário de Treino

Plano de hipertrofia de 6 dias (6 exercícios por dia) com registro de cargas e recomendação de progressão.

## Conteúdo

- `public/index.html`: o app. Mostra o treino do dia, registra carga e repetições por série, guarda o histórico e diz se é hora de aumentar, manter ou reduzir a carga.
- `api/[...path].js` e `lib/api.js`: a API que guarda os registros no Postgres (funções da Vercel).
- `bin/server.js`: servidor para rodar localmente ou em hospedagem com processo contínuo (Railway).
- `design/`: as artes do plano (quadro da semana, uma página por dia e a página de progressão), no formato do canvas de design do Claude.

## Onde os dados ficam

- **Postgres** (tabela `logs`): o estado atual de cada exercício.
- **Histórico** (tabela `logs_history`): cada gravação fica registrada, então um registro apagado por engano pode ser recuperado.
- **No aparelho**: o app guarda uma cópia local. Sem internet, o registro fica no celular e é enviado quando a conexão volta.
- **Backup**: na aba Plano, "Baixar backup" gera um arquivo JSON; "Restaurar backup" carrega de volta.

## Hospedagem (Vercel)

1. Importe este repositório na Vercel (preset "Other", sem build).
2. Em **Storage**, conecte um banco **Neon (Postgres)** ao projeto. Ele cria a variável `DATABASE_URL`.
3. Em **Settings → Environment Variables**, crie `APP_PIN` com o código de acesso.
4. Faça um novo deploy. Teste em `/api/health`.

As tabelas são criadas sozinhas no primeiro acesso.

Rodar localmente: `npm install`, depois `DATABASE_URL=... APP_PIN=... npm start`.

## Plano

| Dia | Treino | Prioridade |
| --- | --- | --- |
| Segunda | Peito, ombros e tríceps A | Espessura do peito e deltoides |
| Terça | Costas e bíceps A | Largura dorsal, espessura das costas e bíceps |
| Quarta | Pernas e core A | Quadríceps, posteriores e estabilidade abdominal |
| Quinta | Peito, ombros e tríceps B | Peito superior, deltoides laterais e posteriores |
| Sexta | Costas e bíceps B | Densidade das costas e bíceps completos |
| Sábado | Pernas e core B | Pernas, equilíbrio muscular e core |

- Sessões de 45–60 min, com 1–2 repetições de reserva na maioria das séries.
- Descanso: 2 min nos compostos, 60–90 s nos isolados.
- Peloton: 3 sessões de 25–30 min (seg, qui, sex), intensidade moderada.

## Regra de progressão

- **Aumente** quando completar o topo da faixa de repetições em todas as séries.
- **Mantenha** enquanto estiver dentro da faixa.
- **Reduza** cerca de 10% se ficar abaixo do mínimo em dois treinos seguidos.
