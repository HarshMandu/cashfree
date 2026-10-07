import { Module } from "@nestjs/common";
import { CashfreeService } from "./cashfree/cashfree.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, CashfreeService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
