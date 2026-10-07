import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { ErpOutboxService } from "./erp-outbox.service";
import { WebhooksService } from "./webhooks.service";

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, ErpOutboxService],
})
export class WebhooksModule {}
