# Cashfree UMS/ERP Payments

NestJS + PostgreSQL/Prisma backend for Cashfree Payment Gateway order creation, payment tracking, verified webhook processing, reconciliation, and reliable ERP status notifications.

## Requirements and local setup

- Node.js 22 LTS or later
- PostgreSQL 16 or Docker Compose
- Cashfree sandbox API credentials and a webhook secret from the Cashfree dashboard

```text
Copy .env.example to .env and configure DATABASE_URL and Cashfree credentials.
npm install
npm run prisma:generate
npx prisma migrate deploy
npm run start:dev
```

The API listens on port `3000` and uses the `/api` prefix. `CASHFREE_ENV` defaults to `sandbox`; set it to `production` only with production keys and a registered HTTPS webhook endpoint. `CASHFREE_API_VERSION` defaults to Cashfree's current `2026-01-01` API version.

To run the API and PostgreSQL using Docker, configure `.env` and run `docker compose up --build`. Compose applies committed Prisma migrations before starting the API. Apply future schema changes by creating a reviewed migration and deploying with `npx prisma migrate deploy`.

## API

### Initiate a payment

`POST /api/payments` requires an `Idempotency-Key` UUID header. Reuse the same key for retries of the same logical request; reusing it with a different body returns `409 Conflict`.

```json
{
	"amount": 1250.5,
	"currency": "INR",
	"customerId": "student123",
	"customerPhone": "+919876543210",
	"customerEmail": "student@example.edu",
	"studentId": "student-123",
	"erpReferenceId": "invoice-2026-001"
}
```

Returns the local payment ID, Cashfree order ID, Cashfree payment session ID, amount, currency, current status, and ERP sync status. The frontend uses the session ID with Cashfree's supported checkout SDK. The amount and ERP reference must be validated/authorized by the calling UMS before invoking this service; never trust a browser-calculated tuition amount.

### Get current status

`GET /api/payments/{cashfreeOrderId}` returns the persisted payment order and its payment-attempt history. This is the ERP/frontend's read API.

### Reconcile with Cashfree

`POST /api/payments/{cashfreeOrderId}/reconcile` fetches the current order status from Cashfree's authenticated Get Order API and persists any status change. Use this for recovery/manual reconciliation when a webhook is delayed or missed.

### Cashfree webhook

Configure `POST /api/webhooks/cashfree` in the Cashfree dashboard and subscribe to payment success/failure/pending events. The handler verifies `x-webhook-signature` from the exact raw body and `x-webhook-timestamp` using Cashfree's documented Base64 HMAC-SHA256 scheme, rejects timestamps outside a five-minute window, deduplicates events, records payment attempts, and updates the order and ERP outbox atomically. Unknown event kinds are recorded without changing status. Valid duplicate deliveries return HTTP 200 safely.

The documented payload fields used here are `type`, `event_time`, `data.order.order_id`, `data.payment.cf_payment_id`, `payment_status`, `payment_amount`, `payment_currency`, `payment_group`, `bank_reference`, and `payment_time`. Cashfree delivery is at-least-once; webhook delivery is not the source of truth when ordering is uncertain, so reconcile with Get Order.

## Payment lifecycle and persistence

- A database row and unique caller idempotency key are committed before contacting Cashfree. The same key is also sent to Cashfree as `x-idempotency-key`; retries reuse the stored Cashfree order ID.
- The order status is `INITIATED`, `PENDING`, `PAID`, `FAILED`, `CANCELLED`, or `EXPIRED`. Each Cashfree payment attempt is retained separately with its provider ID, amount/currency, method, bank reference, event payload, and timestamps.
- Success is terminal and cannot be downgraded by a later failed-attempt notification. Failed, cancelled, pending, and expired outcomes remain represented. Cashfree's `ACTIVE` order maps to local `PENDING`; `PAID`, `EXPIRED`, and `TERMINATED` map to local `PAID`, `EXPIRED`, and `CANCELLED` during reconciliation.
- Webhook records have a unique event key. The order update and ERP outbox insert occur in one database transaction, preventing a committed payment status from losing its ERP notification.
- When `ERP_STATUS_WEBHOOK_URL` is configured, a background worker POSTs status-change messages to it. Failures retry with bounded exponential delay; after ten failures the record is marked `FAILED` for operational review. An optional `ERP_WEBHOOK_SECRET` is sent as `x-erp-webhook-secret`. Without a configured ERP URL, updates remain queued and `erpSyncStatus` stays `PENDING`.
- Monetary values use PostgreSQL `DECIMAL(12,2)`. Do not use the return/redirect URL as proof of payment; only verified webhook updates and authenticated reconciliation should change the financial status.

## Database and migrations

The Prisma schema is in `prisma/schema.prisma`; committed PostgreSQL SQL migrations are in `prisma/migrations`. Models are `PaymentOrder`, `PaymentTransaction`, `WebhookEvent`, and `ErpStatusOutbox`. The outbox lets the existing ERP receive status updates without coupling an external HTTP call to the payment transaction.

## Sandbox test workflow

1. Start PostgreSQL and the API using the sandbox credentials.
2. Configure the webhook URL in Cashfree sandbox and expose the local HTTPS endpoint through a trusted tunnel.
3. Initiate a payment with a fresh UUID idempotency key; use the returned payment session ID with Cashfree's current checkout SDK and sandbox instruments.
4. Exercise success, failure, user-dropped/cancelled and pending cases. Confirm the local status and transaction history via `GET /api/payments/{cashfreeOrderId}`.
5. Replay webhook deliveries and retry the create request with the same key to confirm idempotency. Use the reconcile endpoint to test recovery.
6. Configure a test ERP callback and verify its status messages and retry behavior.

## Tests

Run `npm test` for unit tests and `npm run build` for a TypeScript/Nest build. A PostgreSQL instance and Cashfree sandbox credentials are not needed by the unit tests.

## Security and operational notes

- Keep Cashfree credentials and webhook secrets out of source control. Cashfree signs Payment Gateway webhooks with the client secret; `CASHFREE_WEBHOOK_SECRET` defaults to `CASHFREE_SECRET_KEY` and may be separately set to an active previous secret during key rotation. Keep an old active secret available while its already-sent webhooks can still arrive.
- Use HTTPS in deployed environments. The API must run behind a trusted reverse proxy with request-size and rate limits suitable for your deployment.
- The payment API expects authenticated/authorized access to be provided by the integrating UMS/ERP; add the institution's auth guard and authorization policy before deployment. The sample is not a full UMS and does not implement refunds, settlement reconciliation, or institution-specific ERP authentication.
- The integration uses Cashfree's official [Create Order](https://www.cashfree.com/docs/api-reference/payments/latest/orders/create) and [Get Order](https://www.cashfree.com/docs/api-reference/payments/latest/orders/get) APIs and official [webhook signature](https://www.cashfree.com/docs/api-reference/webhooks/payloads-and-signatures) and [reliability](https://www.cashfree.com/docs/api-reference/webhooks/reliability-and-operations) guidance.
