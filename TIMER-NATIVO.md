# Timer de descanso nativo (via Atalhos)

Isso faz o app disparar o **timer nativo do iPhone** quando você marca uma série
— aí ele roda em segundo plano e toca mesmo com a tela bloqueada ou em outro app.

Você cria o Atalho **uma vez**. Depois é automático.

> A cada série, o iPhone vai piscar rapidinho pro app Atalhos e voltar. É o preço
> de ter o timer nativo. Se preferir o cronômetro fluido dentro do app, deixe a
> opção "No app" em Ajustes.

---

## Passo 1 — Criar o Atalho

1. Abra o app **Atalhos** (Shortcuts) no iPhone.
2. Toque em **+** (canto superior direito) pra criar um novo.
3. Toque no nome no topo (ou na setinha) → **Renomear** → digite exatamente **`Descanso`**.
   (Se usar outro nome, coloque o mesmo nome em Ajustes do app.)

## Passo 2 — Deixar ele receber o número de segundos

1. Toque em **Adicionar ação**.
2. Busque por **`Iniciar timer`** (ou "Start Timer") e toque pra adicionar.
3. Na ação "Iniciar timer", aparece uma duração padrão (ex: 5 minutos).
   - Toque no **número** da duração.
   - Apague e, no teclado de variáveis, escolha **Entrada do Atalho**
     (*Shortcut Input* — é o valor que o app vai mandar).
   - No seletor de unidade ao lado, escolha **segundos**.

   Deve ficar tipo: **Iniciar timer por [Entrada do Atalho] segundos**.

## Passo 3 — Salvar

1. Toque em **OK/Concluído**. O Atalho `Descanso` está pronto.

---

## Passo 4 — Ligar no app

1. No app Meu Treino, vá em **Ajustes → Cronômetro de descanso**.
2. Escolha **"Nativo do iPhone (Atalhos)"**.
3. Confirme que o **Nome do Atalho** está igual (`Descanso`).

Pronto! Agora, ao marcar uma série, o iPhone inicia o timer nativo com o tempo
de descanso daquele exercício.

---

## Testar rápido

Abra o Safari e digite na barra de endereço:
```
shortcuts://run-shortcut?name=Descanso&input=text&text=15
```
Se o Atalho estiver certo, ele inicia um timer de 15 segundos. Na primeira vez o
iPhone pode pedir pra **permitir** rodar o Atalho — é só confirmar.

## Se não funcionar
- Confira se o nome do Atalho é **idêntico** (maiúsculas/acentos contam) ao que
  está em Ajustes.
- Veja se a ação é **"Iniciar timer"** e a unidade está em **segundos**.
- Alguns iPhones mostram um banner "Executar atalho?" — é normal, toque pra permitir.
