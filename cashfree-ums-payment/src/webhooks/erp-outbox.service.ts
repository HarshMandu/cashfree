import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ErpOutboxStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ErpOutboxService {
  private readonly logger = new Logger(ErpOutboxService.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async dispatchPendingNotifications(): Promise<void> {
    const endpoint = this.config.get<string>("ERP_STATUS_WEBHOOK_URL");
    if (!endpoint || this.isRunning) return;

    this.isRunning = true;
    try {
      const staleProcessing = await this.prisma.erpStatusOutbox.updateMany({
        where: {
          state: ErpOutboxStatus.PROCESSING,
          updatedAt: { lt: new Date(Date.now() - 60_000) },
        },
        data: { state: ErpOutboxStatus.PENDING },
      });
      if (staleProcessing.count) {
        this.logger.warn(
          `Requeued ${staleProcessing.count} abandoned ERP notification(s)`,
        );
      }

      const pending = await this.prisma.erpStatusOutbox.findMany({
        where: {
          state: ErpOutboxStatus.PENDING,
          nextAttemptAt: { lte: new Date() },
        },
        orderBy: { createdAt: "asc" },
        take: 25,
      });
      for (const item of pending) {
        const claim = await this.prisma.erpStatusOutbox.updateMany({
          where: { id: item.id, state: ErpOutboxStatus.PENDING },
          data: { state: ErpOutboxStatus.PROCESSING },
        });
        if (!claim.count) continue;

        try {
          const headers: Record<string, string> = {
            "content-type": "application/json",
          };
          const secret = this.config.get<string>("ERP_WEBHOOK_SECRET");
          if (secret) headers["x-erp-webhook-secret"] = secret;
          const response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(item.payload),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok)
            throw new Error(`ERP endpoint returned HTTP ${response.status}`);

          await this.prisma.$transaction([
            this.prisma.erpStatusOutbox.update({
              where: { id: item.id },
              data: {
                state: ErpOutboxStatus.SENT,
                sentAt: new Date(),
                lastError: null,
              },
            }),
            this.prisma.paymentOrder.update({
              where: { id: item.paymentOrderId },
              data: { erpSyncStatus: "SYNCED" },
            }),
          ]);
        } catch (error) {
          const attempts = item.attempts + 1;
          const permanentlyFailed = attempts >= 10;
          const message =
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown ERP delivery error";
          await this.prisma.$transaction([
            this.prisma.erpStatusOutbox.update({
              where: { id: item.id },
              data: {
                state: permanentlyFailed
                  ? ErpOutboxStatus.FAILED
                  : ErpOutboxStatus.PENDING,
                attempts,
                nextAttemptAt: new Date(
                  Date.now() + Math.min(3600, 2 ** attempts * 5) * 1000,
                ),
                lastError: message,
              },
            }),
            this.prisma.paymentOrder.update({
              where: { id: item.paymentOrderId },
              data: { erpSyncStatus: permanentlyFailed ? "FAILED" : "PENDING" },
            }),
          ]);
          this.logger.error(
            `ERP notification ${item.id} failed (attempt ${attempts}): ${message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        "ERP outbox dispatch cycle failed",
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.isRunning = false;
    }
  }
}
