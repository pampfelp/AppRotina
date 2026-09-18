# Sincronização do Google Agenda por gatilho (Apps Script)

Resolve de vez o "toda hora pede pra conectar o Google Agenda de novo": em
vez do navegador segurar um token que expira em 1 hora, um script rodando na
nuvem do Google (na sua própria conta) confere o Firestore a cada 15 minutos
e atualiza a agenda sozinho — com o app fechado, sem popup, sem senha.

Por que isso não é feito automaticamente pelo AppRotina: cria conta, projeto
e gatilho são ações na SUA conta Google, e isso só você pode clicar. Mas é
rápido — uns 5 minutos, um copiar e colar, um "Executar" e pronto.

## Passo a passo

### 1 — criar o projeto do Apps Script

1. Abra <https://script.google.com> logado em **felipecastiged@gmail.com**
   (a mesma conta dona do projeto Firebase do AppRotina).
2. Clique em **Novo projeto**.
3. No canto de cima, troque o nome "Projeto sem título" por `AppRotina Agenda`.

> **Duas pessoas usando o app?** Cada uma instala a própria cópia deste
> script, na própria conta Google, trocando a constante `EMAIL_DONO` no topo
> do `Code.gs` pelo e-mail dela. O script escreve na agenda de quem autorizou
> ele, então dono do script e dono dos dados precisam ser a mesma pessoa.

### 2 — colar o código

1. Vai abrir um arquivo `Código.gs` vazio (ou com uma função `myFunction`
   de exemplo). Apague tudo o que estiver lá dentro.
2. Abra o arquivo [`Code.gs`](Code.gs) deste repositório, copie o conteúdo
   inteiro e cole no lugar.
3. Clique no ícone de **+** ao lado de "Arquivos", na barra lateral
   esquerda → **Configurações do script** (ícone de engrenagem)... na
   verdade, mais simples: clique no **+** → **Editor de manifesto** não
   aparece por padrão. Em vez disso:
   - Clique no ícone de **engrenagem** (⚙) na barra lateral esquerda
     ("Configurações do projeto").
   - Marque a caixa **"Mostrar arquivo de manifesto 'appsscript.json' no
     editor"**.
   - Volte pro ícone de **</>** (Editor) na barra lateral. Agora aparece um
     arquivo `appsscript.json` na lista.
4. Clique em `appsscript.json`, apague o conteúdo e cole o conteúdo do
   arquivo [`appsscript.json`](appsscript.json) deste repositório.
5. Salve com **Ctrl+S** (ou o ícone de disquete no topo).

### 3 — rodar a instalação

1. No topo, ao lado do botão **Executar**, tem um seletor de função —
   escolha **`instalarGatilho`**.
2. Clique em **Executar**.
3. Vai aparecer **Autorização necessária** → **Revisar permissões**.
4. Escolha a conta **felipecastiged@gmail.com**.
5. Vai aparecer um aviso "O Google não verificou este app" — é normal,
   porque é um script seu, só seu, nunca publicado. Clique em
   **Configurações avançadas** → **Acessar AppRotina Agenda (não seguro)**.
6. Revise as permissões pedidas (Agenda e Firestore/Datastore) e clique em
   **Permitir**.
7. A execução roda de novo sozinha. Se aparecer "Execução concluída" sem
   erro vermelho embaixo, terminou.

### 4 — conferir

1. No menu lateral esquerdo, clique no ícone de **relógio** (Gatilhos).
2. Deve aparecer uma linha `sincronizarAgendaAppRotina` rodando **a cada 15
   minutos**.
3. Abra <https://calendar.google.com> e confira se os eventos das suas
   rotinas ativas apareceram (ou já estavam lá, se o navegador tinha
   sincronizado antes).

Pronto. Dali em diante a agenda se mantém sozinha, e o navegador só some do
meio: você pode fechar o AppRotina, deixar o celular sem internet por dias,
que o gatilho do Apps Script continua rodando na nuvem do Google.

## Se algo der errado

- **Menu lateral esquerdo → ícone de relógio → clique nos três pontos da
  linha do gatilho → Ver execuções.** Cada execução com erro mostra a
  mensagem exata.
- Erro `Firestore 403` ou `PERMISSION_DENIED`: a conta que autorizou o
  script (passo 3) precisa ser a mesma dona do projeto Firebase
  `approtina-54752`. Rode `instalarGatilho` de novo logado com a conta
  certa.
- Erro `Firestore 404`: o `FIREBASE_PROJECT_ID` no topo do `Code.gs` não
  bate com o `projectId` do seu `firebase-init.js`. Confira os dois.
- Quer parar de vez: menu lateral → ícone de relógio → três pontos na linha
  do gatilho → **Remover gatilho**.

## O que o script NÃO faz

- Não lê nem guarda sua senha do AppRotina — ele nem passa pela tela de
  login do app, fala direto com o Firestore como você mesmo (dono do
  projeto).
- Não duplica o que o navegador já sincronizou: os dois usam a mesma
  assinatura (hash) gravada no documento pra saber se precisa escrever de
  novo na agenda ou não. Rodar os dois ao mesmo tempo é seguro.
- Não muda nada em `firestore.rules` — o Apps Script acessa como dono do
  projeto (Google Cloud IAM), que é um caminho diferente do login do app
  (Firebase Auth) e não passa pelas regras.
