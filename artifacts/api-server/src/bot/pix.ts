import { logger } from "../lib/logger.js";

const OPENPIX_API_KEY = process.env["OPENPIX_API_KEY"] ?? "";
const BASE_URL = "https://api.openpix.com.br/api/v1";

export interface PixCharge {
  correlationID: string;
  value: number;
  brCode: string;
  qrCodeImage: string;
  paymentLinkUrl: string;
  expiresIn: number;
}

export type PixChargeResult =
  | { ok: true; charge: PixCharge }
  | { ok: false; error: string };

export async function createPixCharge(
  telegramId: string,
  firstName: string,
  valueInCents: number = 2990,
): Promise<{ ok: true; charge: PixCharge } | { ok: false; error: string }> {
  if (!OPENPIX_API_KEY) {
    return { ok: false, error: "OPENPIX_API_KEY não configurada" };
  }

  const correlationID = `doramaai_vip_${telegramId}_${Date.now()}`;

  try {
    const res = await fetch(`${BASE_URL}/charge`, {
      method: "POST",
      headers: {
        Authorization: OPENPIX_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        correlationID,
        value: valueInCents,
        comment: `DoramaAI VIP — ${firstName}`,
        expiresIn: 3600,
        customer: {
          name: firstName,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, "OpenPix charge falhou");
      return { ok: false, error: `Erro ${res.status}: ${body}` };
    }

    const data = (await res.json()) as {
      charge?: {
        correlationID: string;
        brCode: string;
        qrCodeImage: string;
        paymentLinkUrl: string;
        expiresIn: number;
      };
    };

    if (!data.charge) {
      return { ok: false, error: "Resposta inválida da OpenPix" };
    }

    return {
      ok: true,
      charge: {
        correlationID,
        value: valueInCents,
        brCode: data.charge.brCode ?? "",
        qrCodeImage: data.charge.qrCodeImage ?? "",
        paymentLinkUrl: data.charge.paymentLinkUrl ?? "",
        expiresIn: data.charge.expiresIn ?? 3600,
      },
    };
  } catch (err) {
    logger.error({ err }, "OpenPix exceção");
    return { ok: false, error: "Erro de conexão com OpenPix" };
  }
}

export function parseTelegramIdFromCorrelation(correlationID: string): string | null {
  const match = correlationID.match(/^doramaai_vip_(\d+)_/);
  return match?.[1] ?? null;
}
