import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CashfreeCreateOrderRequest,
  CashfreeCreateOrderResponse,
  CashfreeOrderResponse,
} from "./cashfree.types";

@Injectable()
export class CashfreeService {
  constructor(private readonly config: ConfigService) {}

  async createOrder(
    payload: CashfreeCreateOrderRequest,
    idempotencyKey: string,
  ): Promise<CashfreeCreateOrderResponse> {
    const { baseUrl } = this.credentials();
    return this.request<CashfreeCreateOrderResponse>(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "x-idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    });
  }

  async getOrder(orderId: string): Promise<CashfreeOrderResponse> {
    const { baseUrl } = this.credentials();
    return this.request<CashfreeOrderResponse>(
      `${baseUrl}/orders/${encodeURIComponent(orderId)}`,
      { method: "GET" },
    );
  }

  private credentials(): { baseUrl: string } {
    const appId = this.config.get<string>("CASHFREE_APP_ID");
    const secretKey = this.config.get<string>("CASHFREE_SECRET_KEY");
    if (!appId || !secretKey) {
      throw new InternalServerErrorException(
        "Cashfree credentials are not configured",
      );
    }
    const environment = this.config.get<string>("CASHFREE_ENV", "sandbox");
    if (environment !== "sandbox" && environment !== "production") {
      throw new InternalServerErrorException(
        "CASHFREE_ENV must be sandbox or production",
      );
    }
    return {
      baseUrl:
        environment === "production"
          ? "https://api.cashfree.com/pg"
          : "https://sandbox.cashfree.com/pg",
    };
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const appId = this.config.get<string>("CASHFREE_APP_ID");
    const secretKey = this.config.get<string>("CASHFREE_SECRET_KEY");
    if (!appId || !secretKey) {
      throw new InternalServerErrorException(
        "Cashfree credentials are not configured",
      );
    }
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "x-client-id": appId,
          "x-client-secret": secretKey,
          "x-api-version": this.config.get<string>(
            "CASHFREE_API_VERSION",
            "2026-01-01",
          ),
          ...init.headers,
        },
      });
      if (!response.ok) {
        // Avoid reflecting provider response bodies, which can contain sensitive data.
        throw new BadGatewayException(
          `Cashfree API returned HTTP ${response.status}`,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException("Cashfree API request failed");
    }
  }
}
