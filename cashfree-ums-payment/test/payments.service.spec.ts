import { PaymentsService } from "../src/payments/payments.service";
import { CashfreeService } from "../src/payments/cashfree/cashfree.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

describe("PaymentsService", () => {
  const dto = {
    amount: 25,
    currency: "INR",
    customerId: "customer1",
    customerPhone: "+919876543210",
    customerEmail: "customer@example.com",
    studentId: "student-1",
    erpReferenceId: "invoice-1",
  };
  const requestHash = createHash("sha256")
    .update(JSON.stringify(dto))
    .digest("hex");

  function paymentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "local-payment-id",
      studentId: "student-1",
      erpReferenceId: "invoice-1",
      cashfreeOrderId: "order_local",
      paymentSessionId: null,
      amount: new Prisma.Decimal("25.00"),
      currency: "INR",
      status: "INITIATED",
      erpSyncStatus: "PENDING",
      requestHash: "",
      ...overrides,
    };
  }

  it("persists a local order and initiates a Cashfree order", async () => {
    const created = paymentRow();
    const updated = paymentRow({
      paymentSessionId: "session-test",
      status: "PENDING",
    });
    const createOrder = jest.fn().mockResolvedValue({
      order_id: "order_local",
      order_status: "ACTIVE",
      payment_session_id: "session-test",
      cf_order_id: "123",
    });
    const prisma = {
      paymentOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(created),
      },
      $transaction: jest.fn(
        async (callback: (tx: Record<string, any>) => unknown) =>
          callback({
            paymentOrder: {
              findUnique: jest.fn().mockResolvedValue(created),
              update: jest.fn().mockResolvedValue(updated),
            },
            erpStatusOutbox: { upsert: jest.fn().mockResolvedValue({}) },
          }),
      ),
    };
    const service = new PaymentsService(
      { createOrder } as unknown as CashfreeService,
      prisma as unknown as PrismaService,
    );

    const result = await service.create(
      dto,
      "88a6a8c0-f423-4ff1-932c-a0a8b299b084",
    );

    expect(prisma.paymentOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerId: dto.customerId }),
      }),
    );
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        order_amount: 25,
        order_currency: "INR",
        order_id: "order_local",
        customer_details: expect.objectContaining({
          customer_id: "customer1",
          customer_phone: "+919876543210",
          customer_email: "customer@example.com",
        }),
      }),
      "88a6a8c0-f423-4ff1-932c-a0a8b299b084",
    );
    expect(result.status).toBe("PENDING");
    expect(result.paymentSessionId).toBe("session-test");
  });

  it("returns a prior session for an identical idempotent request", async () => {
    const existing = paymentRow({
      paymentSessionId: "existing-session",
      requestHash,
    });
    const createOrder = jest.fn();
    const prisma = {
      paymentOrder: { findUnique: jest.fn().mockResolvedValue(existing) },
    };
    const service = new PaymentsService(
      { createOrder } as unknown as CashfreeService,
      prisma as unknown as PrismaService,
    );

    const result = await service.create(
      dto,
      "88a6a8c0-f423-4ff1-932c-a0a8b299b084",
    );

    expect(result.paymentSessionId).toBe("existing-session");
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("rejects an idempotency key reused with different request data", async () => {
    const existing = paymentRow({ requestHash: "different-hash" });
    const prisma = {
      paymentOrder: { findUnique: jest.fn().mockResolvedValue(existing) },
    };
    const service = new PaymentsService(
      {} as CashfreeService,
      prisma as unknown as PrismaService,
    );

    await expect(
      service.create(dto, "88a6a8c0-f423-4ff1-932c-a0a8b299b084"),
    ).rejects.toThrow(
      "Idempotency key was already used for a different request",
    );
  });
});
