#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { generate, toSQL, toJSON, toCSV, PRESETS } from "./generator.js";
import {
  GenerateOptions,
  SeriesSpec,
  OutputFormat,
  Frequency,
} from "./types.js";

// ---- Freemium gate --------------------------------------------------------
// Free tier limits. A valid Gumroad license key (set via TIMEWEAVER_LICENSE
// env var) unlocks Pro. The key is verified against Gumroad's license API for
// both the monthly and lifetime products.
const FREE_MAX_LENGTH = 200;
const FREE_MAX_SERIES = 1;
const FREE_FORMATS: OutputFormat[] = ["json"];

// Gumroad product ID (public identifier, safe to ship). Single one-time
// product: "TimeWeaver Pro" ($19).
const PRODUCT_IDS = [
  "-gDdK_drCEy9HXY0vuTRwQ==", // TimeWeaver Pro ($19 one-time)
];

const PRO_URL = "https://fixtureforge.gumroad.com/l/timeweaver";

let proStatusCache: boolean | null = null;

async function verifyKeyAgainstProduct(
  productId: string,
  licenseKey: string
): Promise<boolean> {
  const body = new URLSearchParams();
  body.append("product_id", productId);
  body.append("license_key", licenseKey);
  body.append("increment_uses_count", "false");
  const res = await fetch("https://api.gumroad.com/v2/licenses/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status === 404) return false;
  const data: any = await res.json();
  if (!data || data.success !== true) return false;
  const p = data.purchase || {};
  if (p.refunded || p.chargebacked || p.disputed) return false;
  if (p.subscription_ended_at || p.subscription_failed_at) return false;
  return true;
}

async function isPro(): Promise<boolean> {
  if (proStatusCache !== null) return proStatusCache;
  const key = process.env.TIMEWEAVER_LICENSE;
  if (!key || key.trim().length === 0) {
    proStatusCache = false;
    return false;
  }
  const trimmed = key.trim();
  try {
    for (const pid of PRODUCT_IDS) {
      if (await verifyKeyAgainstProduct(pid, trimmed)) {
        proStatusCache = true;
        return true;
      }
    }
    proStatusCache = false;
    return false;
  } catch {
    // Network/Gumroad failure: fail open so a paying customer is never locked
    // out by a transient error. Don't cache, so it re-checks next run.
    return true;
  }
}

function gateError(msg: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${msg}\n\nGet TimeWeaver Pro: ${PRO_URL}`,
      },
    ],
    isError: true,
  };
}

// ---- Server ---------------------------------------------------------------
const server = new McpServer({ name: "timeweaver", version: "0.1.0" });

const seasonalitySchema = z
  .array(
    z.object({
      period: z.number().positive().describe("Cycle length in data points (e.g. 7 for weekly on daily data, 24 for daily on hourly data)."),
      amplitude: z.number().describe("Peak deviation from the baseline for this cycle."),
      phase: z.number().optional().describe("Phase offset in radians (default 0)."),
    })
  )
  .optional()
  .describe("One or more seasonal cycles, summed together. Multiple cycles are a Pro feature.");

const anomaliesSchema = z
  .array(
    z.object({
      type: z.enum(["spike", "level_shift", "trend_change", "dropout"]),
      at: z.number().int().optional().describe("Point index where the anomaly occurs. Omit for a random position."),
      magnitude: z.number().optional().describe("Strength relative to the noise level / baseline (default 5)."),
      count: z.number().int().positive().optional().describe("Number of occurrences for spike/dropout (default 1)."),
    })
  )
  .optional()
  .describe("Injected anomalies for testing detection/alerting. Pro feature.");

server.tool(
  "list_presets",
  "List the built-in time-series presets (realistic ready-made configurations like e-commerce sales, server CPU, IoT temperature, website traffic, stock price, API latency). Use a preset name with generate_timeseries to get sensible defaults you can still override.",
  {},
  async () => {
    const lines = Object.entries(PRESETS).map(
      ([name, p]) => `• ${name} — ${p.description} [frequency: ${p.frequency}]`
    );
    return {
      content: [
        {
          type: "text",
          text: `Available presets:\n\n${lines.join("\n")}\n\nUse one via generate_timeseries with preset="<name>". On the free tier, presets are trimmed to free-tier limits.`,
        },
      ],
    };
  }
);

server.tool(
  "generate_timeseries",
  "Generate realistic synthetic time-series data with configurable trend, seasonality, noise, anomalies, and multiple correlated series. Ideal for testing dashboards, charts, monitoring/alerting, forecasting and anomaly-detection. Output as JSON, CSV, or SQL INSERTs. Use a preset for quick sensible defaults, or specify components explicitly.",
  {
    preset: z
      .string()
      .optional()
      .describe("Optional preset name (see list_presets). Fills sensible defaults; explicit params below override it."),
    length: z.number().int().positive().optional().describe("Number of data points. Default 100."),
    frequency: z
      .enum(["secondly", "minutely", "hourly", "daily", "weekly", "monthly"])
      .optional()
      .describe("Spacing between points. Default daily (or the preset's frequency)."),
    start: z.string().optional().describe("ISO start timestamp, e.g. '2024-01-01T00:00:00Z'. Default 2024-01-01."),
    series_count: z.number().int().positive().optional().describe("How many series to generate. >1 is a Pro feature. Default 1."),
    names: z.array(z.string()).optional().describe("Optional explicit series names."),
    baseline: z.number().optional().describe("Baseline level the series varies around."),
    trend: z.enum(["none", "linear", "exponential", "logistic"]).optional().describe("Trend shape. Non-linear trends are a Pro feature."),
    trend_strength: z.number().optional().describe("Trend magnitude: slope per point (linear), growth rate (exponential), or capacity (logistic)."),
    seasonality: seasonalitySchema,
    noise: z.enum(["gaussian", "ar1"]).optional().describe("Noise model. 'ar1' (autocorrelated) is a Pro feature."),
    noise_level: z.number().nonnegative().optional().describe("Standard deviation of the noise. Default 1."),
    ar1_phi: z.number().optional().describe("AR(1) autocorrelation coefficient (-1..1), used when noise='ar1'."),
    anomalies: anomaliesSchema,
    correlation: z.number().min(0).max(1).optional().describe("Target pairwise correlation between multiple series (0..1). Pro feature."),
    integer: z.boolean().optional().describe("Round values to integers."),
    min: z.number().optional().describe("Clamp values to this minimum."),
    max: z.number().optional().describe("Clamp values to this maximum."),
    seed: z.number().int().optional().describe("Deterministic seed for reproducible output. Pro feature."),
    format: z.enum(["json", "csv", "sql"]).optional().describe("Output format. 'json' (default), 'csv', or 'sql'. CSV and SQL are Pro features."),
    table_name: z.string().optional().describe("Table name for SQL output. Default 'timeseries'."),
  },
  async (args) => {
    try {
      const pro = await isPro();
      const notices: string[] = [];

      // Resolve preset (if any) as the base spec.
      let presetSeries: SeriesSpec = {};
      let presetFrequency: Frequency | undefined;
      if (args.preset) {
        const p = PRESETS[args.preset];
        if (!p) {
          return gateError(
            `Unknown preset '${args.preset}'. Call list_presets to see available names.`
          );
        }
        presetSeries = JSON.parse(JSON.stringify(p.series));
        presetFrequency = p.frequency;
      }

      // Build the per-series spec from preset + explicit overrides.
      const spec: SeriesSpec = { ...presetSeries };
      if (args.baseline !== undefined) spec.baseline = args.baseline;
      if (args.trend !== undefined) spec.trend = args.trend;
      if (args.trend_strength !== undefined) spec.trendStrength = args.trend_strength;
      if (args.seasonality !== undefined) spec.seasonality = args.seasonality;
      if (args.noise !== undefined) spec.noise = args.noise;
      if (args.noise_level !== undefined) spec.noiseLevel = args.noise_level;
      if (args.ar1_phi !== undefined) spec.ar1Phi = args.ar1_phi;
      if (args.anomalies !== undefined) spec.anomalies = args.anomalies;
      if (args.integer !== undefined) spec.integer = args.integer;
      if (args.min !== undefined) spec.min = args.min;
      if (args.max !== undefined) spec.max = args.max;

      const length = args.length ?? 100;
      const frequency: Frequency = args.frequency ?? presetFrequency ?? "daily";
      const seriesCount = args.series_count ?? 1;
      const fmt: OutputFormat = args.format ?? "json";

      // ---- Enforce free-tier limits -------------------------------------
      if (!pro) {
        if (length > FREE_MAX_LENGTH) {
          return gateError(
            `Free tier supports up to ${FREE_MAX_LENGTH} points; you requested ${length}. Upgrade to Pro for long series (up to 100k points).`
          );
        }
        if (seriesCount > FREE_MAX_SERIES) {
          return gateError(
            `Free tier generates a single series; you requested ${seriesCount}. Upgrade to Pro for multiple correlated series.`
          );
        }
        if (!FREE_FORMATS.includes(fmt)) {
          return gateError(
            `Format '${fmt}' is a Pro feature. Free tier supports: ${FREE_FORMATS.join(", ")}.`
          );
        }
        // Trim Pro-only features with a notice rather than failing.
        if (spec.trend && spec.trend !== "none" && spec.trend !== "linear") {
          notices.push(`Note: '${spec.trend}' trend is a Pro feature; used 'linear' instead.`);
          spec.trend = "linear";
        }
        if (spec.seasonality && spec.seasonality.length > 1) {
          notices.push("Note: multiple seasonal cycles are a Pro feature; kept the first only.");
          spec.seasonality = [spec.seasonality[0]];
        }
        if (spec.noise === "ar1") {
          notices.push("Note: autocorrelated (ar1) noise is a Pro feature; used gaussian instead.");
          spec.noise = "gaussian";
        }
        if (spec.anomalies && spec.anomalies.length > 0) {
          notices.push("Note: anomaly injection is a Pro feature and was skipped.");
          spec.anomalies = undefined;
        }
        if (args.correlation !== undefined) {
          notices.push("Note: series correlation is a Pro feature and was ignored.");
        }
        if (args.seed !== undefined) {
          notices.push("Note: deterministic 'seed' is a Pro feature and was ignored.");
        }
      }

      // Assemble the series list.
      const series: SeriesSpec[] = [];
      for (let i = 0; i < (pro ? seriesCount : 1); i++) {
        const copy: SeriesSpec = JSON.parse(JSON.stringify(spec));
        if (args.names && args.names[i]) copy.name = args.names[i];
        series.push(copy);
      }

      const options: GenerateOptions = {
        length,
        frequency,
        start: args.start,
        series,
        correlation: pro ? args.correlation : undefined,
        seed: pro ? args.seed : undefined,
        tableName: args.table_name,
      };

      const result = generate(options);

      let output: string;
      if (fmt === "csv") output = toCSV(result);
      else if (fmt === "sql") output = toSQL(result, args.table_name ?? "timeseries");
      else output = toJSON(result);

      const header = pro ? "" : "[TimeWeaver Free] ";
      const footer = notices.length ? `\n\n${notices.join("\n")}` : "";
      const summary = `${result.points.length} point(s) × ${result.seriesNames.length} series [${result.seriesNames.join(", ")}], ${result.frequency}`;
      return {
        content: [
          {
            type: "text",
            text: `${header}Generated ${summary}:\n\n${output}${footer}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TimeWeaver MCP server running on stdio.");
}

main().catch((err) => {
  console.error("Fatal error starting TimeWeaver:", err);
  process.exit(1);
});
