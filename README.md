# Japan Toilet & Accessibility — MCP Server

> **This is a hosted service. You do NOT self-host it.**
> Get a free API key at **https://api.gachi-tokusuru.com** and connect to the remote endpoint below.
> The source in this repo is published for transparency; the toilet data lives in the hosted backend, so a local clone will not return data.

An MCP server that gives AI agents clean, structured data on **wheelchair-accessible and public toilets in Japan** — for travel, accessibility, and inbound-tourism apps.

- **526 Tokyo stations** — accessible / multipurpose toilets with floor, gender, equipment flags (wheelchair, ostomate, diaper table) and the **nearest station exit** (an original first-party value computed by spatial join — not in any raw dataset).
- **612 municipalities nationwide** — public toilets with wheelchair / baby-seat / ostomate flags, address and coordinates.

Station names accept Japanese (新宿) or romaji (Shinjuku, Kita-Senju) for major stations.

## Connect

- **Endpoint:** `https://api.gachi-tokusuru.com/mcp`
- **Transport:** Streamable HTTP (remote)
- **Auth:** `Authorization: Bearer <API_KEY>` — free key at https://api.gachi-tokusuru.com

```json
{
  "mcpServers": {
    "japan-toilet": {
      "url": "https://api.gachi-tokusuru.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

## Tools

| Tool | Argument | Returns |
|------|----------|---------|
| `get_toilet_by_station` | `station` (Japanese or romaji) | Accessible toilets in a Tokyo station, with `nearest_exit` |
| `get_public_toilet_by_city` | `city` (Japanese) | Public toilets in a municipality (top 50 for large cities) |

## Example

```bash
curl -X POST https://api.gachi-tokusuru.com/mcp \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_toilet_by_station","arguments":{"station":"Shinjuku"}}}'
```

## Pricing

Free 1k · Pro $19/100k · All Access $49/200k · Business $149/500k. Full details: https://api.gachi-tokusuru.com

Paid plans are self-serve: after Stripe checkout the customer is redirected to `/activate?session_id=…`, which verifies payment, resolves the plan from the paid amount, and issues the API key on the page (idempotent per session — reload shows the same key). No manual key handling.

## Operational notes (internal)

- **Subscription cancellation is not yet wired to key revocation** (no Stripe webhook in this build). A cancelled subscriber's key keeps working until manually disabled. **Reconcile monthly**: compare Stripe's active subscriptions against issued `key:*` records and disable keys for lapsed subscribers. A `customer.subscription.deleted` webhook → auto-revoke is the next phase.
- Plan detection in `/activate` is by paid amount (`AMOUNT_TO_PLAN`: $19/$49/$149). If a new plan reuses an existing amount, add an explicit mapping.

## Licensing (two layers — read carefully)

- **Code** in this repository: MIT (see [LICENSE](LICENSE)). Applies to the server code only.
- **Data** returned by the API is **NOT MIT.** It is derived from:
  - Tokyo Metropolitan Government, Bureau of Social Welfare — accessible toilet dataset (**CC BY 4.0**)
  - BODIK nationwide public-toilet open data (**CC BY 4.0** or equivalent municipal terms)
  - English station names via ODPT (Public Transportation Open Data Center)
- `nearest_exit` is an original derived value by gachi-tokusuru.com.
- Attribution is returned in every API response. Timeliness, accuracy and completeness are not guaranteed.
