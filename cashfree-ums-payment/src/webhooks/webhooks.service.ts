import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, PaymentStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

type CashfreeWebhook = Record<string, any>;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async handleCashfree(
    payload: CashfreeWebhook,
    rawBody?: Buffer,
    signature?: string,
    timestamp?: string,
    idempotencyKey?: string,
  ) {
    const webhookSecret =
      this.config.get<string>("CASHFREE_WEBHOOK_SECRET") ||
      this.config.get<string>("CASHFREE_SECRET_KEY");
    if (!webhookSecret || !signature || !timestamp || !rawBody) {
      throw new UnauthorizedException("Webhook secret is not configured");
    }

    const timestampMs = Number(timestamp);
    if (
      !/^\d{10,16}$/.test(timestamp) ||
      !Number.isSafeInteger(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000
    ) {
      throw new UnauthorizedException(
        "Webhook timestamp is invalid or expired",
      );
    }

    const expected = createHmac("sha256", webhookSecret)
      .update(timestamp + rawBody.toString("utf8"))
      .digest();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
      throw new UnauthorizedException("Webhook signature is invalid");
    }
    const received = Buffer.from(signature, "base64");
    if (
      received.length !== expected.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new UnauthorizedException("Webhook signature is invalid");
    }

    const eventType =
      typeof payload.type === "string" ? payload.type : "UNKNOWN";
    const payment = payload.data?.payment ?? {};
    const order = payload.data?.order ?? {};
    const cashfreeOrderId =
      typeof order.order_id === "string" ? order.order_id : null;
    const paymentId =
      payment.cf_payment_id == null ? "" : String(payment.cf_payment_id);
    const eventTime =
      typeof payload.event_time === "string" ? payload.event_time : "";
    const parsedEventTime = eventTime ? new Date(eventTime) : null;
    const providerEventAt =
      parsedEventTime && !Number.isNaN(parsedEventTime.getTime())
        ? parsedEventTime
        : new Date(timestampMs);
    const eventId = idempotencyKey
      ? `cashfree:${idempotencyKey}`
      : createHash("sha256")
          .update(
            `${eventType}|${cashfreeOrderId ?? ""}|${paymentId}|${eventTime}|${rawBody.toString("utf8")}`,
          )
          .digest("hex");

    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.webhookEvent.findUnique({
          where: { eventId },
        });
        if (existing) return;

        await tx.webhookEvent.create({
          data: {
            eventId,
            eventType,
            cashfreeOrderId,
            payload: payload as Prisma.InputJsonValue,
          },
        });

        if (!cashfreeOrderId) {
          await tx.webhookEvent.update({
            where: { eventId },
            data: { processed: true, processedAt: new Date() },
          });
          return;
        }
        const paymentOrder = await tx.paymentOrder.findUnique({
          where: { cashfreeOrderId },
        });
        if (!paymentOrder) {
          this.logger.warn(
            `Received Cashfree event for unknown order ${cashfreeOrderId}`,
          );
          await tx.webhookEvent.update({
            where: { eventId },
            data: { processed: true, processedAt: new Date() },
          });
          return;
        }

        const nextStatus = this.mapPaymentStatus(
          eventType,
          payment.payment_status,
        );
        if (paymentId && nextStatus) {
          const amount = Number(
            payment.payment_amount ?? order.order_amount ?? paymentOrder.amount,
          );
          const currency = String(
            payment.payment_currency ??
              order.order_currency ??
              paymentOrder.currency,
          );
          const paymentTime = payment.payment_time
            ? new Date(payment.payment_time)
            : null;
          const safePaymentTime =
            paymentTime && !Number.isNaN(paymentTime.getTime())
              ? paymentTime
              : null;
          const previousAttempt = await tx.paymentTransaction.findUnique({
            where: { cashfreePaymentId: paymentId },
          });
          if (
            !previousAttempt ||
            !previousAttempt.providerEventAt ||
            providerEventAt >= previousAttempt.providerEventAt
          ) {
            await tx.paymentTransaction.upsert({
              where: { cashfreePaymentId: paymentId },
              create: {
                paymentOrderId: paymentOrder.id,
                cashfreePaymentId: paymentId,
                amount: new Prisma.Decimal(
                  Number.isFinite(amount)
                    ? amount.toFixed(2)
                    : paymentOrder.amount.toString(),
                ),
                currency,
                status: nextStatus,
                paymentMethod: payment.payment_group ?? null,
                bankReference: payment.bank_reference ?? null,
                paymentTime: safePaymentTime,
                providerEventAt,
                rawResponse: payload as Prisma.InputJsonValue,
              },
              update: {
                status: nextStatus,
                paymentMethod: payment.payment_group ?? null,
                bankReference: payment.bank_reference ?? null,
                paymentTime: safePaymentTime,
                providerEventAt,
                rawResponse: payload as Prisma.InputJsonValue,
              },
            });
          }
        }

        if (nextStatus) {
          const effectiveStatus =
            paymentOrder.status === "PAID" && nextStatus !== "PAID"
              ? PaymentStatus.PAID
              : nextStatus;
          const statusChanged = effectiveStatus !== paymentOrder.status;
          const isNewerEvent =
            !paymentOrder.lastCashfreeEventAt ||
            providerEventAt >= paymentOrder.lastCashfreeEventAt;
          if (nextStatus === PaymentStatus.PAID || isNewerEvent) {
            await tx.paymentOrder.update({
              where: { id: paymentOrder.id },
              data: {
                status: effectiveStatus,
                ...(statusChanged ? { erpSyncStatus: "PENDING" as const } : {}),
                lastCashfreeEventAt:
                  paymentOrder.lastCashfreeEventAt &&
                  paymentOrder.lastCashfreeEventAt > providerEventAt
                    ? paymentOrder.lastCashfreeEventAt
                    : providerEventAt,
              },
            });
          }
          if (
            statusChanged &&
            (nextStatus === PaymentStatus.PAID || isNewerEvent)
          ) {
            const outboxPayload = {
              eventId,
              payment: {
                paymentOrderId: paymentOrder.id,
                cashfreeOrderId,
                erpReferenceId: paymentOrder.erpReferenceId,
                studentId: paymentOrder.studentId,
                status: effectiveStatus,
                amount: paymentOrder.amount.toString(),
                currency: paymentOrder.currency,
              },
            };
            await tx.erpStatusOutbox.create({
              data: {
                eventId,
                paymentOrderId: paymentOrder.id,
                status: effectiveStatus,
                payload: outboxPayload,
              },
            });
          }
        }
        await tx.webhookEvent.update({
          where: { eventId },
          data: { processed: true, processedAt: new Date() },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return { received: true, duplicate: true };
      }
      throw error;
    }
    return { received: true };
  }

  private mapPaymentStatus(
    type: string,
    rawStatus?: string,
  ): PaymentStatus | null {
    const status = String(rawStatus ?? "").toUpperCase();
    if (type.includes("SUCCESS") || status === "SUCCESS")
      return PaymentStatus.PAID;
    if (type.includes("PENDING") || status === "PENDING")
      return PaymentStatus.PENDING;
    if (
      type.includes("CANCEL") ||
      type.includes("USER_DROPPED") ||
      status === "CANCELLED" ||
      status === "USER_DROPPED"
    ) {
      return PaymentStatus.CANCELLED;
    }
    if (
      type.includes("FAIL") ||
      type.includes("VOID") ||
      status === "FAILED" ||
      status === "VOID"
    ) {
      return PaymentStatus.FAILED;
    }
    if (type.includes("EXPIRED") || status === "EXPIRED")
      return PaymentStatus.EXPIRED;
    return null;
  }
}
