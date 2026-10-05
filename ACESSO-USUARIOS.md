# Controlar quem pode usar o app (lista de permitidos)

O app é **multiusuário**: cada pessoa cria o próprio login (e-mail + senha) e tem
seus treinos totalmente separados. Ninguém vê o do outro.

Para que **só gente que você autorizar** consiga entrar (mesmo que alguém ache o
link), existe a lista **`allowed`** no Firestore. Só os e-mails que estiverem
nessa lista conseguem usar o app.

> Importante: adicionar o e-mail na lista **não cria a conta** da pessoa — ela
> ainda precisa abrir o app e se cadastrar com esse mesmo e-mail. A lista só diz
> *quem tem permissão*.

---

## Liberar uma pessoa (inclusive você)

1. No **console do Firebase** → **Firestore Database** → aba **Dados**.
2. **Na primeira vez**, clique em **Iniciar coleção**, nome: **`allowed`**.
   (Nas próximas vezes, a coleção `allowed` já existe — é só abrir.)
3. Clique em **Adicionar documento**.
4. No **ID do documento**, digite o **e-mail da pessoa, tudo minúsculo**
   (ex: `maria.silva@gmail.com`).
5. Adicione um campo qualquer só pra poder salvar, por exemplo:
   - Campo: `nome` · Tipo: `string` · Valor: `Maria`
6. Clique em **Salvar**.

Pronto. Agora essa pessoa pode abrir o app e criar a conta dela com esse e-mail.

**Comece adicionando o SEU e-mail** — senão nem você entra.

---

## Tirar o acesso de alguém

1. Firestore → coleção **`allowed`** → abra o documento do e-mail dela.
2. Clique nos **três pontinhos → Excluir documento**.

A pessoa perde o acesso na hora (não consegue mais carregar nem salvar).
Se quiser apagar também o login dela, vá em **Authentication → Users**, ache o
e-mail e exclua.

---

## Dicas

- **Sempre em minúsculas.** O app já converte o e-mail digitado pra minúsculo no
  login, então os IDs aqui também precisam estar em minúsculo pra bater.
- **Quantas pessoas?** Pode colocar quantas quiser — o plano grátis aguarda bem
  mais que 5. É só adicionar um documento por e-mail.
- Quem tentar entrar sem estar na lista vê a tela **"Acesso não liberado"** e não
  consegue usar nada.
