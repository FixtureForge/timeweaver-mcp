# TimeWeaver MCP

**Synthetic time-series test data, on demand, inside your AI client.** Generate realistic series with configurable trend, seasonality, noise, anomalies, and multiple correlated streams — perfect for testing dashboards, charts, monitoring/alerting, forecasting models, and anomaly detection. Output as JSON, CSV, or SQL.

Part of the [fixturelab](https://github.com/FixtureForge) test-data tools. Its sibling [SeedWeaver](https://github.com/FixtureForge/seedweaver-mcp) does relational/database test data.

## Why

LLMs are unreliable at hand-generating coherent time-series — trends drift, "seasonality" doesn't actually repeat, and correlations between series are fake. TimeWeaver generates data with **verifiable statistical properties**: a linear trend really has the slope you asked for, a seasonal cycle really repeats at its period, two correlated series really hit the target correlation, and AR(1) noise really has the autocorrelation you set.

## Install

```
npx -y timeweaver-mcp
```

Add to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "timeweaver": {
      "command": "npx",
      "args": ["-y", "timeweaver-mcp"]
    }
  }
}
```

To unlock Pro, add your license key:

```json
{
  "mcpServers": {
    "timeweaver": {
      "command": "npx",
      "args": ["-y", "timeweaver-mcp"],
      "env": { "TIMEWEAVER_LICENSE": "YOUR-KEY-HERE" }
    }
  }
}
```

## Tools

- **`generate_timeseries`** — generate data from a preset and/or explicit components (length, frequency, baseline, trend, seasonality, noise, anomalies, correlated series). Output JSON / CSV / SQL.
- **`list_presets`** — list built-in presets: `ecommerce_sales`, `server_cpu`, `iot_temperature`, `website_traffic`, `stock_price`, `api_latency_ms`.

## Examples

> "Generate 90 days of daily e-commerce sales using the ecommerce_sales preset."

> "Generate 3 correlated server CPU series over 500 minutes with correlation 0.8, as CSV."

> "Make an hourly temperature series with a daily cycle and a level shift on day 5, as SQL into a table called readings."

## Free vs Pro

| | Free | Pro |
|---|---|---|
| Points per series | 200 | up to 100,000 |
| Series | 1 | up to many, correlated |
| Trend | none / linear | + exponential, logistic |
| Seasonality | 1 cycle | multiple cycles |
| Noise | gaussian | + AR(1) autocorrelated |
| Anomalies | – | spikes, level shifts, trend changes, dropouts |
| Output | JSON | + CSV, SQL |
| Deterministic seed | – | ✓ |

Pro: **$19/mo** or **$39 one-time** → https://fixtureforge.gumroad.com/l/timeweaver

## License

MIT (the server code). Pro features require a valid license key.
