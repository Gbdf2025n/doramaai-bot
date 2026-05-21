import { Router } from "express";
import { setVip } from "../bot/subscribers.js";
import { parseTelegramIdFromCorrelation } from "../bot/pix.js";
import { logger } from "../lib/logger.js";
import { notifyVipActivated } from "../bot/bot.js";

const router = Router();

router.post("/webhooks/pix", (req, res) => {
  res.status(200).json({ ok: true });

  const body = req.body as {
    event?: string;
    charge?: {
      correlationID?: string;
      status?: string;
      value?: number;
    };
  };

  logger.info({ event: body.event }, "PIX webhook recebido");

  if (body.event === "OPENPIX:CHARGE_COMPLETED" && body.charge?.correlationID) {
    const telegramId = parseTelegramIdFromCorrelation(body.charge.correlationID);
    if (telegramId) {
      setVip(telegramId, true);
      logger.info({ telegramId }, "VIP ativado via PIX automático");
      notifyVipActivated(Number(telegramId)).catch(() => {});
    }
  }
});

export default router;
