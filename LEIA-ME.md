# DoramaAI Bot — Completo + Railway

## Projeto Railway ativo
https://railway.com/project/ac92165f-0d42-43ac-95a1-4d4ce6fdae26

## Variaveis de ambiente (configurar no Railway > Variables)

  TELEGRAM_BOT_TOKEN   = token do @BotFather (obrigatório)
  DID_API_KEY          = chave da API D-ID (para vídeos animados)
  TELEGRAM_ADMIN_ID    = seu ID no Telegram (para comandos admin)
  OPENPIX_API_KEY      = chave OpenPix (PIX automático — opcional)
  PIX_KEY              = chave PIX manual (opcional)
  TONCOIN_ADDRESS      = endereço TON (opcional)
  VIP_PRICE_BRL        = preço VIP em reais (padrão: 29.90)

## Webhook PIX automático
Após deploy no Railway, configure no painel OpenPix:
  URL: https://SEU_DOMINIO_RAILWAY/api/webhooks/pix
  Evento: OPENPIX:CHARGE_COMPLETED

## Deploy manual (PC com Node.js instalado)
  npm install -g @railway/cli
  railway login
  railway link ac92165f-0d42-43ac-95a1-4d4ce6fdae26
  railway up

## Comandos admin no Telegram
  /setvip <id> true|false  — ativar/desativar VIP
  /broadcast <mensagem>    — enviar para todos
  /setpix <chave>          — atualizar chave PIX
  /settoncoin <endereço>   — atualizar TON
  /stats                   — ver estatísticas
  /adminhelp               — lista de comandos

## Build
  Build: pnpm install && pnpm --filter @workspace/api-server run build
  Start: node --enable-source-maps artifacts/api-server/dist/index.mjs
