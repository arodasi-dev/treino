# Servidor de dados do Meu Treino (homeserver)

Substitui o Firestore: guarda treinos e histórico num banco SQLite no seu servidor.
Um só usuário, protegido por token. O app (GitHub Pages) conversa com ele pelo Tailscale.

## Instalar no servidor

1. Copie esta pasta (`servidor/`) para o servidor, por exemplo em `~/treino-api`.
2. Crie o arquivo `.env` com um token longo:

   ```bash
   cd ~/treino-api && cp .env.example .env && sed -i "s/^TREINO_TOKEN=.*/TREINO_TOKEN=$(openssl rand -hex 24)/" .env && cat .env
   ```

   Guarde o token que aparecer: você vai colar no app.

3. Suba o container:

   ```bash
   cd ~/treino-api && docker compose up -d --build
   ```

4. Publique na tailnet com HTTPS (confira com `tailscale serve status` que a porta 8447 está livre):

   ```bash
   sudo tailscale serve --bg --https=8447 http://127.0.0.1:8795
   ```

   Endereço final: `https://homelab.tail69a525.ts.net:8447`

## Abrir o app pelo próprio servidor

O servidor também entrega o app (só `index.html`, `app.js`, `sw.js`, o manifesto e os ícones):

- No iPhone/PC, com o Tailscale ligado, abra `https://homelab.tail69a525.ts.net:8447/`.
- Na primeira vez ele pede o token (o endereço já vem preenchido).
- No iPhone: **Compartilhar → Adicionar à Tela de Início** para instalar. Depois da 1ª visita ele
  funciona offline e sincroniza quando o servidor voltar.

Assim o app novo roda separado do que está no GitHub Pages, sem mexer na `main`.

## Trazer os dados atuais

**Sem senha:** no app antigo, **Ajustes → Exportar backup**; no app novo, **Ajustes → Importar backup**.

## Migrar os dados do Firestore (alternativa, precisa do e-mail e da senha do app)

Rode **no próprio servidor** (não precisa de navegador nem de Tailscale no seu aparelho):

```bash
cd ~/treino-app/servidor && python3 migrar.py
```

Ele pede o e-mail e a senha que você já usa no app, copia treinos e histórico e confere
as contagens no fim. Pode rodar de novo sem duplicar. Nada é apagado do Firestore.

(A página `migrar.html` faz o mesmo pelo navegador, mas exige que o domínio esteja
autorizado no Firebase; o script acima evita isso.)

## Backup

- Os dados ficam em `~/treino-api/dados/treino.db`.
- Uma cópia diária é guardada em `dados/backups/` (as últimas 14).
- Para uma cópia manual: `cp ~/treino-api/dados/treino.db ~/treino-api-backup.db`

## Segurança

- A porta só escuta em `127.0.0.1`; quem publica na tailnet é o `tailscale serve`.
- Todas as rotas (menos `/health`) exigem `Authorization: Bearer <token>`.
- CORS só aceita a origem do app (`ALLOWED_ORIGINS` no `.env`).
