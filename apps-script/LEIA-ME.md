# Agenda e avisos com o AppRotina fechado

Cada pessoa conecta a própria conta Google no AppRotina. O script antigo,
fixo em EMAIL_DONO, atendia apenas ao proprietário. Não conceda IAM no
Firebase a outros usuários para contornar isso.

## Preparar o servidor

1. Abra o projeto AppRotina Agenda no Apps Script, como proprietário do
   Firebase. Faça cópia do código atual antes de trocar.
2. Publique firestore.rules antes do frontend. O status config/agenda por
   usuário é só leitura para o app; apenas o servidor o escreve.
3. Atualize Code.gs, OAuth.gs, Notificacoes.gs e appsscript.json. Os três
   arquivos .gs podem ser concatenados em um único arquivo do editor. Não
   mantenha cópias adicionais das mesmas declarações globais.
4. Implante um Aplicativo da Web, executado como proprietário, acessível aos
   usuários do app. O endpoint exige token Firebase válido e e-mail confirmado
   para iniciar uma conexão ou desconectar.
5. Configure um cliente OAuth Aplicativo da Web exclusivo para o servidor.
   O URI de redirecionamento é exatamente a URL /exec da implantação.
   O projeto OAuth deve estar em produção: teste pode impor expiração curta.
6. Em Configurações do projeto > Propriedades do script, salve:
   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e OAUTH_REDIRECT_URI.
   O último valor é a URL /exec. Nunca copie o segredo ou refresh tokens para
   frontend, relatórios, capturas ou commits.
7. Coloque a mesma URL pública em AGENDA_SERVIDOR_URL no firebase-init.js.
   Publique com as versões de todos os assets locais atualizadas juntas.
8. Execute instalarGatilho e autorize os escopos. Ele valida a conta,
   sincroniza e mantém um gatilho de 15 minutos. Confira Execuções.

Editores do projeto Apps Script são administradores das credenciais guardadas
nas propriedades. Cada pessoa autoriza sua agenda; ninguém precisa receber
permissão administrativa no Firebase para usar o aplicativo.

## Conectar cada pessoa

1. Entre no AppRotina com seu próprio e-mail confirmado.
2. Abra Perfil > Configurações > Google Agenda > Conectar automaticamente.
3. Na janela aberta, continue com o Google usando a mesma conta do app.
4. Autorize o acesso aos eventos e volte ao AppRotina pelo ícone.
5. Confira Sincronização automática e última execução. Mudanças podem levar
   até 15 minutos para chegar à agenda.

Conta Google diferente da conta Firebase é recusada. Desconectar a
sincronização revoga o acesso e mantém os eventos históricos na agenda.
O fallback temporário do navegador continua dependendo de um token da sessão.

## Ativar avisos diretos

1. No Firebase do AppRotina, confirme FCM HTTP v1 e gere o par Web Push.
   Use a configuração do AppRotina, nunca a chave do ERP.
2. Salve só a chave pública em VAPID_PUBLIC_KEY nas propriedades do script.
   A instalação publica config/notificacoes.vapidKey no Firestore depois de
   conferir o envio FCM em simulação. Contas confirmadas leem esse documento.
3. Execute instalarGatilhoPush e confira o gatilho de um minuto. O proprietário
   precisa da permissão de envio FCM e do escopo firebase.messaging no manifesto.
4. No painel da agenda, toque Ativar avisos neste aparelho. No iPhone, use o
   app da Tela de Início em sistema compatível.

O emissor lê dados apenas de contas com aparelho inscrito, usa cache de quatro
minutos e confere a atividade atual antes de enviar. Novas atividades podem
avisar com alguns minutos de atraso. Inscrição inválida é removida; falha de
permissão não conta como envio. As cotas do Firestore e Apps Script continuam
valendo. Desativar os avisos é respeitado após reabrir o aplicativo.

## Conferir antes de considerar concluído

- Rode node tests/run.mjs na pasta do projeto (simulações sem produção).
- Crie tarefa futura e feche o app; confira o evento após uma rodada do servidor.
- Edite e sincronize novamente: deve atualizar o mesmo evento, sem duplicar.
- Concluir atrasada deve parar cobrança; concluir compromisso mantém histórico.
- Exclusões do app precisam sair da agenda após o processamento da fila.
- Duas contas precisam receber apenas os próprios eventos e avisos.
- Teste push real no iPhone bloqueado e a desativação seguida de recarga.

Sem configuração, autorização real, gatilhos e teste no aparelho, código pronto
não comprova sincronização ou entrega em produção.
