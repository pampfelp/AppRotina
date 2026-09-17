# AppRotina

Rotinas fixas que caem sozinhas num checklist diário, o que ficou atrás
continua no topo, e o Google Agenda cobra o que não foi feito.

Padrão de sempre: HTML/CSS/JS puro, sem build, Firestore como banco, GitHub
Pages como hospedagem, instalável como PWA.

---

## As três telas, e o que cada regra faz

**Hoje (checklist).** Mostra, do mais antigo pro mais atual, agrupado por
data com o dia da semana:

- pendente de qualquer dia passado, com a tarja `ATRASADO`, sempre no topo;
- tudo de hoje, e o que já foi concluído hoje fica com um traço em cima;
- o que você criou pra um dia futuro, mais abaixo.

Concluída de dia passado **sai** desta tela. Ela não deixa de existir: vive no
Histórico, dentro do Painel, e de lá dá pra desfazer ou excluir.

**Painel.** Progresso, taxa de conclusão e o ranking de onde você se dedicou
mais, por categoria, com filtro de 7, 30 ou 90 dias. O Histórico fica no fim.

**Rotinas.** Cada rotina é um bloco: nome, horário, duração, dias da semana e
as atividades dentro dele, cada atividade com sua categoria. Salvar já lança
hoje, se hoje for dia dela.

**Perfil.** Seus dados. O menu de três traços, no canto de cima, abre as
Configurações: categorias, Google Agenda, sobre e sair.

### Descartar

Ao lado da caixinha existe o botão de descartar, pro caso de você decidir que
não vai fazer mais. A tarefa sai do checklist, para de cobrar no Agenda, e
**não** conta como concluída no ranking. Sem isso, a única saída seria marcar
como feita, e aí o ranking passaria a mentir.

### Google Agenda

- Rotina ativa vira **um evento recorrente semanal**. Criado uma vez, notifica
  pra sempre, mesmo com o app fechado.
- Tarefa avulsa de hoje em diante vira **um evento no horário dela**, com a
  duração que você escolher. Tarefa vinda de rotina não ganha evento próprio,
  porque o recorrente acima já cobre o horário dela.
- Atrasada ainda pendente vira **uma série diária de 14 dias** no horário
  original em que ela deveria ter sido feita. A cobrança para quando você
  concluir ou descartar.

**O que é apagado e o que não é.** O evento de um compromisso é registro do
que aconteceu, então concluir a tarefa **não** apaga (sua agenda é lida por
outras pessoas, e apagar reunião passada é destrutivo). A série de cobrança de
uma atrasada é cobrança, então concluir ou descartar apaga. Descartar apaga os
dois, porque descartar significa que o compromisso deixou de existir.

**Como saber se está tudo lá.** Cada linha do checklist leva um ícone de
agenda: verde quando o item está no Google Agenda, apagado quando não está. E
em **Perfil › Configurações › Google Agenda** tem a contagem por tipo
(rotinas, avulsas, atrasadas), a hora da última sincronização e o último erro
que a API devolveu, se houver.

**O furo conhecido.** Uma tarefa que vence num dia em que você nunca abre o
app só ganha a série de cobrança quando você abrir. As rotinas continuam
notificando nesses dias, porque o evento recorrente não depende do app. Se
isso incomodar, a saída é um Apps Script com gatilho por tempo, que fecha o
furo e não está construído aqui.

---

## Cotas, antes de construir em cima (`antecipacao.md` E1)

| Serviço | Teto no grátis | O que acontece ao estourar | Reseta |
|---|---|---|---|
| Firestore leitura | 50 mil/dia | leitura para, escrita continua, o app fica inútil | meia-noite (PT) |
| Firestore escrita | 20 mil/dia | escrita para | meia-noite (PT) |
| Google Calendar API | 1 milhão de consultas/dia | erro 403 nas chamadas | rolando |

O app foi escrito pra caber com folga: as escutas são recortadas (pendentes de
qualquer data, mais tudo dos últimos 90 dias), nunca a coleção inteira, e a
sincronização com o Agenda só chama a API quando o conteúdo mudou de verdade,
comparando uma assinatura guardada no próprio documento.

**Firebase Storage e Cloud Functions não são usados de propósito.** Os dois
exigem o plano Blaze, com cartão cadastrado, mesmo dentro da cota. Foi essa
parede que parou a foto do Track Bravos do Norte no primeiro dia do retiro,
em 2026-09-10.

---

## Passo a passo pra ligar (cada clique, na ordem)

Até terminar o passo 4, o app abre mostrando um aviso de que falta ligar o
Firebase. Isso é o esperado.

### Passo 1 — criar o projeto Firebase

1. Abra <https://console.firebase.google.com> logado em
   **felipecastiged@gmail.com**.
2. Clique em **Adicionar projeto**.
3. Nome do projeto: `approtina` (sem espaço e sem acento, porque vira o
   `projectId`).
4. Na tela do Google Analytics, **desmarque** e clique em **Criar projeto**.
5. Espere e clique em **Continuar**.

### Passo 2 — criar o banco

1. Menu da esquerda → **Criar** → **Firestore Database**.
2. Clique em **Criar banco de dados**.
3. Local: escolha **`southamerica-east1` (São Paulo)**. Isso não dá pra mudar
   depois.
4. Modo: escolha qualquer um, tanto faz, porque as regras de verdade vão pelo
   passo 4.
5. Clique em **Criar**.

### Passo 3 — pegar a config e colar no código

1. Ícone de engrenagem (canto de cima, à esquerda) → **Configurações do
   projeto**.
2. Role até **Seus apps** e clique no ícone **`</>`** (Web).
3. Apelido do app: `AppRotina`. **Não marque** "Configurar também o Firebase
   Hosting" (a hospedagem é GitHub Pages).
4. Clique em **Registrar app**.
5. Vai aparecer um bloco `const firebaseConfig = { ... }`. Copie só o que está
   entre as chaves.
6. Abra `firebase-init.js` deste repositório e substitua os `COLE_AQUI` pelos
   valores copiados: `apiKey`, `authDomain`, `projectId`, `storageBucket`,
   `messagingSenderId`, `appId`.
7. Salve. Essa config é pública por design, pode ir pro GitHub sem problema.

### Passo 4 — publicar as regras do banco

1. No console, menu da esquerda → **Firestore Database** → aba **Regras**.
2. Apague tudo que está na caixa.
3. Abra `firestore.rules` deste repositório, copie o conteúdo inteiro e cole.
4. Confirme que a linha do e-mail está com o seu:
   `request.auth.token.email in ['felipecastiged@gmail.com']`.
5. Clique em **Publicar**.

Sem esse passo o app vai dar `permission-denied` e um aviso vermelho na tela.

### Passo 5 — ligar o login

1. Menu da esquerda → **Criar** → **Authentication** → **Vamos começar**.
2. Aba **Sign-in method** → **Adicionar novo provedor** → **Google** →
   ative a chave → escolha o e-mail de suporte (o seu) → **Salvar**.
3. **Adicionar novo provedor** → **E-mail/senha** → ative a primeira chave
   (deixe "Link de e-mail" desligado) → **Salvar**.
4. Aba **Settings** → **Authorized domains**. Precisa ter:
   - `localhost` (já vem)
   - `approtina.firebaseapp.com` (já vem)
   - **`pampfelp.github.io`** ← clique em **Add domain** e acrescente.

Pra criar sua senha: abra o app, clique em **Criar senha**, digite o mesmo
e-mail e uma senha de 6 caracteres ou mais. Pode entrar dos dois jeitos
depois; as regras autorizam por e-mail, então os dois caminhos veem a mesma
lista.

### Passo 6 — ligar o Google Agenda

Isso acontece no Google Cloud Console, que é o mesmo projeto do Firebase visto
por outra porta.

**6a. Ativar a API do Calendar**

1. Abra <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
2. No seletor de projeto, em cima, escolha **approtina**.
3. Clique em **Ativar** e espere.

**6b. Configurar a tela de consentimento**

1. Menu da esquerda → **APIs e serviços** → **Tela de permissão OAuth**.
2. Tipo de usuário: **Externo** → **Criar**.
3. Nome do app: `AppRotina`. E-mail de suporte e e-mail do desenvolvedor: o
   seu. → **Salvar e continuar**.
4. Em **Escopos**, clique em **Adicionar ou remover escopos**, procure por
   `calendar.events`, marque
   `https://www.googleapis.com/auth/calendar.events` → **Atualizar** →
   **Salvar e continuar**.
5. Em **Usuários de teste**, clique em **Adicionar usuários** e coloque
   **felipecastiged@gmail.com** → **Salvar e continuar**.

Deixe em **Testing**, não precisa publicar. Publicar pediria verificação do
Google, que é semanas de espera pra nada, já que o app é só seu.

**6c. Pegar o ID do cliente e liberar as origens**

1. Menu da esquerda → **APIs e serviços** → **Credenciais**.
2. Em **IDs do cliente OAuth 2.0**, vai existir uma linha chamada algo como
   **"Web client (auto created by Google Service)"**, criada pelo Firebase no
   passo 5. **Use essa mesma**, clique nela.

   Usar a mesma é o que importa: a permissão do Agenda que você dá no login
   com Google vale pra essa credencial. Se fosse um cliente diferente, ele
   pediria consentimento duas vezes.
3. Em **Origens JavaScript autorizadas**, clique em **Adicionar URI** e
   acrescente, uma por linha:
   - `https://pampfelp.github.io`
   - `http://localhost:8741`  ← a porta do `TESTAR - index.html.bat`
4. Clique em **Salvar**.
5. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`).
6. Abra `firebase-init.js` e cole em `GOOGLE_CLIENT_ID`, no lugar do
   `COLE_AQUI`.

Mudança de origem pode levar alguns minutos pra valer.

### Passo 7 — testar na sua máquina

1. Dê dois cliques em **`TESTAR - index.html.bat`**.
2. O navegador abre em `http://localhost:8741/index.html`.
3. Aperte **F12** e deixe o Console aberto.
4. Entre com o Google. Não deve aparecer nenhum erro vermelho.
5. Vá em **Rotinas** → **Nova rotina**, crie uma que caia hoje e salve.
6. Volte em **Hoje**: as atividades dela têm que estar lá.
7. Vá em **Perfil** → três traços → **Google Agenda** → **Conectar** →
   autorize → **Sincronizar agora**.
8. Abra <https://calendar.google.com> e confirme o evento recorrente.
9. Marque uma caixinha e veja a barra de progresso e o anel mexerem.

### Passo 8 — publicar no GitHub Pages

1. No GitHub, abra o repositório **pampfelp/AppRotina**.
2. **Settings** → **Pages**.
3. Em **Source**, escolha **Deploy from a branch**.
4. Branch: **`main`**, pasta **`/ (root)`** → **Save**.
5. Espere um ou dois minutos e abra `https://pampfelp.github.io/AppRotina/`.

**Confira a branch antes de comemorar.** Um push numa branch que não é a fonte
do Pages funciona sem erro nenhum e o site continua servindo a versão velha.
Isso já custou duas rodadas de "nada ainda" com print, em 2026-09-02
(`antecipacao.md` D1). Depois de publicar, recarregue a URL pública e procure
por algo novo na tela, não confie só no push ter dado certo.

### Passo 9 — instalar no celular

1. Abra `https://pampfelp.github.io/AppRotina/` no Chrome do celular.
2. Menu de três pontos → **Instalar app** (ou aceite o banner do próprio app).
3. No iPhone: **Compartilhar** → **Adicionar à Tela de Início**.

O ícone é um visto verde neon em fundo grafite, diferente dos outros apps, de
propósito (`pwa-checklist.md` regra 4). O escopo do manifest é a pasta
`/AppRotina/`, então ele não briga com o SolarGreen-ERP nem com a Jornada do
Milhão, que moram na mesma origem.

---

## Se você já tinha ligado antes de 2026-09-17

**Republique as `firestore.rules`.** A correção do lançamento no Google Agenda
acrescentou três campos nas tarefas (`duracaoMin`, `agendaEventoId`,
`agendaHash`), e as regras validam a lista exata de campos permitidos com
`hasOnly()`. Com as regras antigas publicadas, **toda gravação de tarefa passa
a ser recusada** com `permission-denied`.

É o passo 4 de novo: console do Firebase → Firestore Database → aba Regras →
apagar o conteúdo → colar o `firestore.rules` deste repositório → Publicar.

---

## Checklist de "está tudo ligado?"

- [ ] `firebase-init.js` sem nenhum `COLE_AQUI` sobrando
- [ ] `firestore.rules` publicada com o seu e-mail
- [ ] Google e E-mail/senha ativados, e `pampfelp.github.io` nos domínios autorizados
- [ ] API do Calendar ativada, escopo `calendar.events` na tela de consentimento, você como usuário de teste
- [ ] `GOOGLE_CLIENT_ID` preenchido com o MESMO cliente que o Firebase criou
- [ ] Origens `https://pampfelp.github.io` e `http://localhost:8741` liberadas
- [ ] Testado pelo `.bat` sem erro no Console
- [ ] GitHub Pages servindo a branch certa, conferido na URL pública
- [ ] Instalado no celular

---

## Arquivos

| Arquivo | O que faz |
|---|---|
| `index.html` | as quatro abas, a pílula inferior e o menu de configurações |
| `style.css` | tema escuro grafite com neon. A paleta dos gráficos passou no validador de contraste e daltonismo; não trocar sem revalidar |
| `shared.js` | utilitários: datas sem bug de fuso, toast, modal, registro de escutas, indicador de sincronização |
| `firebase-init.js` | config do Firebase, ID do cliente OAuth e lista de e-mails autorizados |
| `auth.js` | login com Google e com e-mail/senha |
| `agenda.js` | Google Calendar: evento recorrente por rotina, série de cobrança por atrasada |
| `app.js` | as telas, o lançamento diário e as regras do checklist |
| `firestore.rules` | autorização por e-mail e validação de formato |
| `service-worker.js` | cache do esqueleto, com prefixo `rot-` pra não apagar o cache dos outros apps da mesma origem |
| `TESTAR - index.html.bat` | servidor local de duplo clique |

## Detalhes que vão te poupar tempo depois

- **Trocar de e-mail ou acrescentar alguém** pede as DUAS listas:
  `EMAILS_AUTORIZADOS` em `firebase-init.js` e a linha `in [...]` em
  `firestore.rules`. Duas listas em mãos diferentes divergem em silêncio.
- **Mexeu em CSS ou JS?** Suba o `?v=` no `index.html` e o `CACHE_NAME` no
  `service-worker.js`. Sem isso o navegador serve a versão antiga e parece
  bug novo.
- **App já instalado não relê o manifest sozinho.** Pra sentir mudança de
  ícone ou de escopo, desinstale e instale de novo.
- **O painel olha 90 dias pra trás, no máximo.** É de propósito, pra escuta
  não crescer com a base. Pendente de qualquer idade continua no checklist,
  sem esse limite.
- **O lançamento recupera no máximo 45 dias.** Se o app ficar mais tempo sem
  abrir, os dias além disso não são lançados, pra você não voltar de viagem
  com centenas de tarefas de uma vez.
