import { Body, Controller, Get, Headers, Param, Post } from "@nestjs/common";
import { CreatePaymentDto } from "./dto/create-payment.dto";
import { PaymentsService } from "./payments.service";

@Controller("payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  create(
    @Body() dto: CreatePaymentDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.payments.create(dto, idempotencyKey ?? "");
  }

  @Get(":orderId")
  findOne(@Param("orderId") orderId: string) {
    return this.payments.findByOrderId(orderId);
  }

  @Post(":orderId/reconcile")
  reconcile(@Param("orderId") orderId: string) {
    return this.payments.reconcile(orderId);
  }
}
