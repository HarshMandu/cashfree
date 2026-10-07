import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";
import { WebhooksService } from "../src/webhooks/webhooks.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("WebhooksService", () => {
  const secret = "webhook-secret";
  const rawBody = Buffer.from(
    JSON.stringify({ type: "OTHER_EVENT", data: {} }),
  );
  const payload = { type: "OTHER_EVENT", data: {} };
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret)
    .update(timestamp + rawBody.toString("utf8"))
    .digest("base64");

  function serviceWithTransaction() {
    const tx = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      paymentOrder: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (tx: Record<string, any>) => unknown) => callback(tx),
      ),
    };
    const config = { get: jest.fn().mockReturnValue(secret) };
    return {
      service: new WebhooksService(
        config as unknown as ConfigService,
        prisma as unknown as PrismaService,
      ),
      tx,
      prisma,
    };
  }

  it("rejects requests with an invalid signature before touching persistence", async () => {
    const { service, prisma } = serviceWithTransaction();

    await expect(
      service.handleCashfree(payload, rawBody, "bad-signature", timestamp),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("verifies the raw body and records a valid webhook event", async () => {
    const { service, tx } = serviceWithTransaction();

    const result = await service.handleCashfree(
      payload,
      rawBody,
      signature,
      timestamp,
    );

    expect(result).toEqual({ received: true });
    expect(tx.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "OTHER_EVENT" }),
      }),
    );
  });
});
