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
   sudo tailscale serve --bg --https=8447 http://127.0.0.1:8787
   ```

   Endereço final: `https://homelab.tail69a525.ts.net:8447`

## Migrar os dados do Firestore

Com o servidor no ar e o Tailscale ligado, abra `migrar.html` no app publicado,
informe o endereço, o token, e o e-mail/senha que você já usa no app. A página copia
tudo e confere as contagens. Pode rodar de novo sem duplicar. Nada é apagado do Firestore.

## Backup

- Os dados ficam em `~/treino-api/dados/treino.db`.
- Uma cópia diária é guardada em `dados/backups/` (as últimas 14).
- Para uma cópia manual: `cp ~/treino-api/dados/treino.db ~/treino-api-backup.db`

## Segurança

- A porta só escuta em `127.0.0.1`; quem publica na tailnet é o `tailscale serve`.
- Todas as rotas (menos `/health`) exigem `Authorization: Bearer <token>`.
- CORS só aceita a origem do app (`ALLOWED_ORIGINS` no `.env`).
