# Meu Treino — como colocar no iPhone

App pessoal de treino. Funciona offline, sincroniza na nuvem (Firebase) e
aparece em todos os seus aparelhos. Nada fica atrelado a conta corporativa —
usa sua conta Google/GitHub pessoal.

Ordem das coisas: **Firebase → GitHub Pages → iPhone**.

---

## Passo 1 — Configurar o Firebase (banco na nuvem)

Siga o guia **FIREBASE-SETUP.md** (uns 10 min). No fim desse passo o arquivo
`firebase-config.js` estará preenchido com as suas chaves. Faça isso **antes**
de subir pro GitHub.

---

## Passo 2 — Subir no GitHub Pages (hospedagem grátis, sua)

Você precisa de uma conta **pessoal** no GitHub (crie em https://github.com/signup se não tiver — use um e-mail pessoal, não o do trabalho).

### Opção A — pelo site (mais simples, sem comando)

1. Entre no GitHub e clique em **New repository**.
2. Nome do repositório: `treino` (pode ser outro). Deixe **Public**. Clique em **Create repository**.
3. Na página do repo novo, clique em **uploading an existing file**.
4. Arraste **todos os arquivos desta pasta** (index.html, app.js, firebase-config.js **já preenchido**, sw.js, manifest.webmanifest e os .png). ⚠️ Arraste os arquivos, não a pasta.
5. Clique em **Commit changes**.
6. Vá em **Settings** (do repositório) → menu lateral **Pages**.
7. Em *Build and deployment* → *Source*, escolha **Deploy from a branch**.
8. Em *Branch*, escolha **main** e pasta **/ (root)**. Clique em **Save**.
9. Espere ~1 minuto. O endereço do seu app aparece no topo:
   `https://SEU-USUARIO.github.io/treino/`

### Opção B — pelo Git (se preferir o terminal)

```bash
cd caminho/da/pasta/treino
git init
git add .
git commit -m "Meu app de treino"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/treino.git
git push -u origin main
```
Depois faça os passos 6 a 9 da Opção A pra ligar o Pages.

---

## Passo 3 — Instalar no iPhone

1. Abra o endereço `https://SEU-USUARIO.github.io/treino/` no **Safari** (tem que ser Safari).
2. Toque no botão **Compartilhar** (quadrado com seta pra cima).
3. Role e toque em **Adicionar à Tela de Início**.
4. Confirme. Vai aparecer o ícone do haltere na sua tela, igual a um app.
5. Abra pelo ícone e **crie sua conta** (e-mail + senha). Use o mesmo login em
   todo aparelho pra sincronizar.

A partir daí, abra sempre pelo ícone — tela cheia, sem barra do Safari, e
funciona mesmo sem internet na academia (sincroniza quando a internet voltar).

---

## Backup dos dados

Os dados já ficam na nuvem (Firebase), então você não perde se trocar de
aparelho — é só logar de novo. Se quiser uma cópia extra, dentro do app em
**Ajustes → Exportar backup** você gera um arquivo. Pra restaurar, **Importar backup**.

---

## Quiser mudar algo depois

É só editar os arquivos e subir de novo no GitHub (ou dar outro `git push`).
Se mudar o app, troque `treino-v1` por `treino-v2` no arquivo `sw.js` pra forçar
a atualização no iPhone.

Os treinos de exemplo (A/B/C) já vêm prontos pra você editar direto no app —
toque em cada exercício pra ajustar nome, séries, reps, carga e descanso.
