import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from "@nestjs/common";
import { Request } from "express";
import { WebhooksService } from "./webhooks.service";

@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post("cashfree")
  @HttpCode(200)
  handleCashfree(
    @Body() payload: Record<string, unknown>,
    @Headers("x-webhook-signature") signature?: string,
    @Headers("x-webhook-timestamp") timestamp?: string,
    @Headers("x-idempotency-key") idempotencyKey?: string,
    @Req() request?: RawBodyRequest<Request>,
  ) {
    return this.webhooks.handleCashfree(
      payload,
      request?.rawBody,
      signature,
      timestamp,
      idempotencyKey,
    );
  }
}
