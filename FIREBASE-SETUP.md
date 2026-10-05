# Configurar o Firebase (banco na nuvem)

Isso liga o seu app a um banco de dados grátis do Google. Depois disso, seus
treinos ficam salvos na nuvem, sincronizam entre aparelhos e continuam
funcionando offline (sincronizam sozinhos quando a internet volta).

Use uma conta **Google pessoal** (não a do trabalho). Leva uns 10 minutos.

---

## 1. Criar o projeto

1. Acesse https://console.firebase.google.com
2. Clique em **Adicionar projeto** (ou *Create a project*).
3. Nome: `meu-treino` (ou o que quiser). Avançar.
4. Pode **desligar** o Google Analytics (não precisa). Criar projeto.

## 2. Registrar o app web

1. Na tela inicial do projeto, clique no ícone **`</>`** (Web).
2. Apelido do app: `Meu Treino`. **Não** marque "Firebase Hosting". Registrar.
3. Vai aparecer um bloco de código com `const firebaseConfig = { ... }`.
   **Copie os valores** (apiKey, authDomain, projectId, etc.).
4. Abra o arquivo **`firebase-config.js`** do app e cole os valores no lugar dos
   `COLE_...`. Salve. Exemplo de como fica:

   ```js
   window.firebaseConfig = {
     apiKey: "AIzaSyB...suachave...",
     authDomain: "meu-treino-xxxx.firebaseapp.com",
     projectId: "meu-treino-xxxx",
     storageBucket: "meu-treino-xxxx.appspot.com",
     messagingSenderId: "123456789012",
     appId: "1:123456789012:web:abc123..."
   };
   ```
   > Pode deixar essas chaves no código — não são segredo. Quem protege os dados
   > são as regras do passo 4.

## 3. Ligar o login por e-mail

1. No menu lateral: **Criação → Authentication** (Autenticação).
2. Clique em **Começar**.
3. Aba **Sign-in method** → clique em **E-mail/senha** → **Ativar** → Salvar.

## 4. Criar o banco (Firestore) e proteger os dados

1. No menu lateral: **Criação → Firestore Database**.
2. Clique em **Criar banco de dados**.
3. Local: escolha **southamerica-east1** (São Paulo) ou **nam5**. Avançar.
4. Pode escolher **"Iniciar no modo de produção"**. Criar.
5. Depois que criar, vá na aba **Regras** (Rules), apague o que estiver lá e
   cole exatamente isto, e clique em **Publicar**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {

       // true só se o e-mail logado estiver na lista de permitidos
       function liberado() {
         return request.auth != null
           && exists(/databases/$(database)/documents/allowed/$(request.auth.token.email));
       }

       // cada pessoa só acessa os próprios dados — e só se estiver liberada
       match /users/{userId}/{document=**} {
         allow read, write: if request.auth != null
           && request.auth.uid == userId
           && liberado();
       }

       // a lista de permitidos só é editada pelo console, nunca pelo app
       match /allowed/{email} {
         allow read, write: if false;
       }
     }
   }
   ```
   Isso garante que **cada pessoa só acessa os próprios dados** e que **só
   e-mails autorizados** conseguem usar o app.

6. **Libere o seu e-mail** (senão nem você entra): siga o guia
   **ACESSO-USUARIOS.md** pra adicionar os e-mails permitidos (o seu primeiro).

## 5. (Se o login não funcionar no GitHub Pages)

1. Em **Authentication → Settings → Authorized domains** (Domínios autorizados).
2. Clique em **Add domain** e adicione `SEU-USUARIO.github.io`.

---

## Pronto!

Abra o app. Vai aparecer a tela de login:
- **Criar conta** com um e-mail e senha (qualquer e-mail seu, mínimo 6 dígitos de senha).
- Use **o mesmo e-mail e senha** em todos os aparelhos → os dados sincronizam.

Na primeira vez, o app já cria 3 treinos de exemplo (A/B/C) pra você editar.

### Importante sobre as chaves

Depois de preencher o `firebase-config.js`, lembre de subir esse arquivo
atualizado pro GitHub (ou dar `git push`) pra valer no app publicado.
