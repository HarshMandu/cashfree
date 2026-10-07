import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { CashfreeService } from "./cashfree/cashfree.service";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class PaymentsService {
  constructor(
    private readonly cashfree: CashfreeService,
    private readonly prisma: PrismaService,
  ) {}

  async create(dto: CreatePaymentDto, idempotencyKey: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        idempotencyKey,
      )
    ) {
      throw new BadRequestException(
        "A UUID Idempotency-Key header is required",
      );
    }
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          amount: Number(dto.amount.toFixed(2)),
          currency: dto.currency,
          customerId: dto.customerId,
          customerPhone: dto.customerPhone,
          customerEmail: dto.customerEmail ?? null,
          studentId: dto.studentId,
          erpReferenceId: dto.erpReferenceId,
        }),
      )
      .digest("hex");
    let payment = await this.prisma.paymentOrder.findUnique({
      where: { idempotencyKey },
    });

    if (payment && payment.requestHash !== requestHash) {
      throw new ConflictException(
        "Idempotency key was already used for a different request",
      );
    }

    if (!payment) {
      const cashfreeOrderId = `order_${randomUUID().replace(/-/g, "")}`;
      try {
        payment = await this.prisma.paymentOrder.create({
          data: {
            studentId: dto.studentId,
            erpReferenceId: dto.erpReferenceId,
            customerId: dto.customerId,
            cashfreeOrderId,
            amount: new Prisma.Decimal(dto.amount.toFixed(2)),
            currency: dto.currency,
            idempotencyKey,
            requestHash,
          },
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2002"
        ) {
          throw error;
        }
        payment = await this.prisma.paymentOrder.findUnique({
          where: { idempotencyKey },
        });
        if (!payment) throw error;
        if (payment.requestHash !== requestHash) {
          throw new ConflictException(
            "Idempotency key was already used for a different request",
          );
        }
      }
    }

    if (payment.paymentSessionId) return this.toResponse(payment);
    const localPaymentId = payment.id;

    const result = await this.cashfree.createOrder(
      {
        order_id: payment.cashfreeOrderId,
        order_amount: Number(payment.amount),
        order_currency: payment.currency,
        customer_details: {
          customer_id: dto.customerId,
          customer_phone: dto.customerPhone,
          ...(dto.customerEmail ? { customer_email: dto.customerEmail } : {}),
        },
      },
      idempotencyKey,
    );

    const nextStatus = this.mapOrderStatus(result.order_status) ?? "PENDING";
    const eventId = `create:${idempotencyKey}:${nextStatus}`;
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.paymentOrder.findUnique({
        where: { id: localPaymentId },
      });
      if (!current) throw new NotFoundException("Payment order not found");
      const statusChanged = current.status !== nextStatus;
      payment = await tx.paymentOrder.update({
        where: { id: localPaymentId },
        data: {
          paymentSessionId: result.payment_session_id,
          status: nextStatus,
          ...(statusChanged ? { erpSyncStatus: "PENDING" as const } : {}),
        },
      });
      if (statusChanged) {
        const payload = {
          eventId,
          payment: {
            paymentOrderId: payment.id,
            cashfreeOrderId: payment.cashfreeOrderId,
            erpReferenceId: payment.erpReferenceId,
            studentId: payment.studentId,
            status: nextStatus,
            amount: payment.amount.toString(),
            currency: payment.currency,
          },
        };
        await tx.erpStatusOutbox.upsert({
          where: { eventId },
          create: {
            eventId,
            paymentOrderId: payment.id,
            status: nextStatus,
            payload,
          },
          update: {},
        });
      }
    });
    return this.toResponse(payment);
  }

  async findByOrderId(orderId: string) {
    const payment = await this.prisma.paymentOrder.findUnique({
      where: { cashfreeOrderId: orderId },
      select: {
        id: true,
        studentId: true,
        erpReferenceId: true,
        cashfreeOrderId: true,
        paymentSessionId: true,
        amount: true,
        currency: true,
        status: true,
        erpSyncStatus: true,
        createdAt: true,
        updatedAt: true,
        transactions: {
          select: {
            cashfreePaymentId: true,
            amount: true,
            currency: true,
            status: true,
            paymentMethod: true,
            bankReference: true,
            paymentTime: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!payment) throw new NotFoundException("Payment order not found");
    return payment;
  }

  async reconcile(orderId: string) {
    const payment = await this.prisma.paymentOrder.findUnique({
      where: { cashfreeOrderId: orderId },
    });
    if (!payment) throw new NotFoundException("Payment order not found");
    const remote = await this.cashfree.getOrder(orderId);
    const providerStatus = this.mapOrderStatus(remote.order_status);
    const remoteStatus =
      payment.status === "PAID" && providerStatus !== "PAID"
        ? "PAID"
        : providerStatus;
    if (remoteStatus && remoteStatus !== payment.status) {
      const eventId = `reconcile:${orderId}:${remoteStatus}:${Date.now()}`;
      const payload = {
        eventId,
        payment: {
          paymentOrderId: payment.id,
          cashfreeOrderId: payment.cashfreeOrderId,
          erpReferenceId: payment.erpReferenceId,
          studentId: payment.studentId,
          status: remoteStatus,
          amount: payment.amount.toString(),
          currency: payment.currency,
        },
      };
      await this.prisma.$transaction(async (tx) => {
        await tx.paymentOrder.update({
          where: { id: payment.id },
          data: { status: remoteStatus, erpSyncStatus: "PENDING" },
        });
        await tx.erpStatusOutbox.create({
          data: {
            eventId,
            paymentOrderId: payment.id,
            status: remoteStatus,
            payload,
          },
        });
      });
    }
    return this.findByOrderId(orderId);
  }

  private mapOrderStatus(
    status: string,
  ): "PAID" | "PENDING" | "CANCELLED" | "EXPIRED" | null {
    if (status === "PAID") return "PAID";
    if (status === "EXPIRED") return "EXPIRED";
    if (status === "TERMINATED") return "CANCELLED";
    if (status === "ACTIVE") return "PENDING";
    return null;
  }

  private toResponse(payment: {
    id: string;
    cashfreeOrderId: string;
    paymentSessionId: string | null;
    amount: Prisma.Decimal;
    currency: string;
    status: string;
    erpSyncStatus: string;
  }) {
    return {
      paymentId: payment.id,
      orderId: payment.cashfreeOrderId,
      paymentSessionId: payment.paymentSessionId,
      amount: payment.amount.toString(),
      currency: payment.currency,
      status: payment.status,
      erpSyncStatus: payment.erpSyncStatus,
    };
  }
}
