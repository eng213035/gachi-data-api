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

Free: 1,000 req/mo · Pro: $19/mo (100,000 req/mo) · Business (cross-operator station master, ridership trends, bulk datasets) — in development. See https://api.gachi-tokusuru.com

## Licensing (two layers — read carefully)

- **Code** in this repository: MIT (see [LICENSE](LICENSE)). Applies to the server code only.
- **Data** returned by the API is **NOT MIT.** It is derived from:
  - Tokyo Metropolitan Government, Bureau of Social Welfare — accessible toilet dataset (**CC BY 4.0**)
  - BODIK nationwide public-toilet open data (**CC BY 4.0** or equivalent municipal terms)
  - English station names via ODPT (Public Transportation Open Data Center)
- `nearest_exit` is an original derived value by gachi-tokusuru.com.
- Attribution is returned in every API response. Timeliness, accuracy and completeness are not guaranteed.
