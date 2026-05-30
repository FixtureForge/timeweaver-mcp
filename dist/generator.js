// ---- Deterministic PRNG (mulberry32) --------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// Standard normal via Box-Muller, driven by the seeded rng.
function gaussian(rng) {
    let u = 0;
    let v = 0;
    while (u === 0)
        u = rng();
    while (v === 0)
        v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// ---- Timestamps -----------------------------------------------------------
const STEP_MS = {
    secondly: 1000,
    minutely: 60_000,
    hourly: 3_600_000,
    daily: 86_400_000,
    weekly: 604_800_000,
};
function buildTimestamps(length, frequency, start) {
    const startDate = start ? new Date(start) : new Date(Date.UTC(2024, 0, 1));
    if (isNaN(startDate.getTime())) {
        throw new Error(`Invalid start timestamp: ${start}`);
    }
    const out = [];
    if (frequency === "monthly") {
        for (let i = 0; i < length; i++) {
            const d = new Date(startDate);
            d.setUTCMonth(d.getUTCMonth() + i);
            out.push(d.toISOString());
        }
    }
    else {
        const step = STEP_MS[frequency];
        for (let i = 0; i < length; i++) {
            out.push(new Date(startDate.getTime() + i * step).toISOString());
        }
    }
    return out;
}
// ---- Components -----------------------------------------------------------
function trendComponent(s, t, length, baseline) {
    const k = s.trendStrength ?? 0;
    switch (s.trend) {
        case "linear":
            return k * t;
        case "exponential":
            // baseline grows geometrically; component is the increment over baseline
            return baseline * (Math.exp(k * t) - 1);
        case "logistic": {
            const capacity = k; // interpret strength as the saturation capacity
            const steep = 10 / Math.max(1, length);
            const mid = length / 2;
            const f = (x) => capacity / (1 + Math.exp(-steep * (x - mid)));
            return f(t) - f(0); // start near zero
        }
        default:
            return 0;
    }
}
function seasonalComponent(s, t) {
    if (!s.seasonality || s.seasonality.length === 0)
        return 0;
    let sum = 0;
    for (const comp of s.seasonality) {
        if (comp.period <= 0)
            continue;
        sum += comp.amplitude * Math.sin((2 * Math.PI * t) / comp.period + (comp.phase ?? 0));
    }
    return sum;
}
function applyAnomalies(anomalies, vals, rng, noiseLevel, baseline, length, floor) {
    if (!anomalies)
        return;
    const scale = noiseLevel || Math.abs(baseline) || 1;
    for (const a of anomalies) {
        const mag = a.magnitude ?? 5;
        const amount = mag * scale;
        const count = a.count ?? 1;
        switch (a.type) {
            case "spike": {
                for (let i = 0; i < count; i++) {
                    const idx = a.at ?? Math.floor(rng() * length);
                    if (idx >= 0 && idx < length) {
                        // Randomly signed when position is random; positive when pinned.
                        const sign = a.at === undefined && rng() < 0.5 ? -1 : 1;
                        vals[idx] += amount * sign;
                    }
                }
                break;
            }
            case "dropout": {
                for (let i = 0; i < count; i++) {
                    const idx = a.at ?? Math.floor(rng() * length);
                    if (idx >= 0 && idx < length)
                        vals[idx] = floor;
                }
                break;
            }
            case "level_shift": {
                const idx = a.at ?? Math.floor(length / 2);
                for (let t = idx; t < length; t++)
                    vals[t] += amount;
                break;
            }
            case "trend_change": {
                const idx = a.at ?? Math.floor(length / 2);
                const perStep = (a.magnitude ?? 0.1) * scale;
                for (let t = idx; t < length; t++)
                    vals[t] += perStep * (t - idx);
                break;
            }
        }
    }
}
// ---- Main generator -------------------------------------------------------
export function generate(opts) {
    const { length, frequency, start, series } = opts;
    if (length <= 0)
        throw new Error("length must be a positive integer.");
    if (series.length === 0)
        throw new Error("At least one series is required.");
    const rng = mulberry32(opts.seed !== undefined ? opts.seed : Math.floor(Math.random() * 2 ** 31));
    const c = Math.max(0, Math.min(1, opts.correlation ?? 0));
    // Shared latent factor sequence used to correlate noise across series.
    const common = new Array(length);
    for (let t = 0; t < length; t++)
        common[t] = gaussian(rng);
    const timestamps = buildTimestamps(length, frequency, start);
    // Resolve unique series names.
    const seriesNames = [];
    const seen = new Set();
    series.forEach((s, i) => {
        let nm = s.name ?? `series_${i + 1}`;
        let suffix = 2;
        while (seen.has(nm))
            nm = `${s.name ?? `series_${i + 1}`}_${suffix++}`;
        seen.add(nm);
        seriesNames.push(nm);
    });
    const valuesPerSeries = [];
    for (let i = 0; i < series.length; i++) {
        const s = series[i];
        const baseline = s.baseline ?? 0;
        const noiseLevel = s.noiseLevel ?? 1;
        const phi = s.ar1Phi ?? 0;
        const useAR = s.noise === "ar1" && phi !== 0;
        // Correlated standard-normal noise: corr between any two series ≈ c.
        const eps = new Array(length);
        const rootC = Math.sqrt(c);
        const rootOneMinusC = Math.sqrt(1 - c);
        for (let t = 0; t < length; t++) {
            eps[t] = rootC * common[t] + rootOneMinusC * gaussian(rng);
        }
        // Optional AR(1), kept stationary (unit variance preserved).
        const noiseSeq = new Array(length);
        if (useAR) {
            noiseSeq[0] = eps[0];
            const innov = Math.sqrt(1 - phi * phi);
            for (let t = 1; t < length; t++) {
                noiseSeq[t] = phi * noiseSeq[t - 1] + innov * eps[t];
            }
        }
        else {
            for (let t = 0; t < length; t++)
                noiseSeq[t] = eps[t];
        }
        const vals = new Array(length);
        for (let t = 0; t < length; t++) {
            let v = baseline;
            v += trendComponent(s, t, length, baseline);
            v += seasonalComponent(s, t);
            v += noiseLevel * noiseSeq[t];
            vals[t] = v;
        }
        const floor = s.min ?? 0;
        applyAnomalies(s.anomalies, vals, rng, noiseLevel, baseline, length, floor);
        for (let t = 0; t < length; t++) {
            if (s.min !== undefined)
                vals[t] = Math.max(s.min, vals[t]);
            if (s.max !== undefined)
                vals[t] = Math.min(s.max, vals[t]);
            vals[t] = s.integer ? Math.round(vals[t]) : Math.round(vals[t] * 1000) / 1000;
        }
        valuesPerSeries.push(vals);
    }
    const points = timestamps.map((ts, t) => {
        const values = {};
        seriesNames.forEach((nm, i) => (values[nm] = valuesPerSeries[i][t]));
        return { timestamp: ts, values };
    });
    return { points, seriesNames, frequency };
}
// ---- Output formatters ----------------------------------------------------
export function toJSON(r) {
    const rows = r.points.map((p) => ({ timestamp: p.timestamp, ...p.values }));
    return JSON.stringify(rows, null, 2);
}
export function toCSV(r) {
    const header = ["timestamp", ...r.seriesNames].join(",");
    const lines = r.points.map((p) => [p.timestamp, ...r.seriesNames.map((n) => p.values[n])].join(","));
    return [header, ...lines].join("\n");
}
function sanitizeIdent(name) {
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
export function toSQL(r, table = "timeseries") {
    const tbl = sanitizeIdent(table);
    const cols = ["ts", ...r.seriesNames.map(sanitizeIdent)];
    const colList = cols.map((c) => `"${c}"`).join(", ");
    const lines = r.points.map((p) => {
        const vals = [`'${p.timestamp}'`, ...r.seriesNames.map((n) => p.values[n])];
        return `INSERT INTO "${tbl}" (${colList}) VALUES (${vals.join(", ")});`;
    });
    return lines.join("\n");
}
export const PRESETS = {
    ecommerce_sales: {
        description: "Daily e-commerce sales: upward trend, weekly + yearly seasonality, occasional promo spikes.",
        frequency: "daily",
        series: {
            baseline: 1000,
            trend: "linear",
            trendStrength: 2,
            seasonality: [
                { period: 7, amplitude: 200 },
                { period: 365, amplitude: 400 },
            ],
            noiseLevel: 80,
            anomalies: [{ type: "spike", count: 3, magnitude: 6 }],
            min: 0,
            integer: true,
        },
    },
    server_cpu: {
        description: "Per-minute server CPU %: autocorrelated noise around a baseline with periodic load and occasional spikes (clamped 0-100).",
        frequency: "minutely",
        series: {
            baseline: 35,
            seasonality: [{ period: 60, amplitude: 10 }],
            noise: "ar1",
            ar1Phi: 0.6,
            noiseLevel: 5,
            anomalies: [{ type: "spike", count: 5, magnitude: 8 }],
            min: 0,
            max: 100,
        },
    },
    iot_temperature: {
        description: "Hourly IoT temperature sensor: daily cycle with slow upward drift and small sensor noise.",
        frequency: "hourly",
        series: {
            baseline: 21,
            trend: "linear",
            trendStrength: 0.002,
            seasonality: [{ period: 24, amplitude: 4 }],
            noiseLevel: 0.4,
        },
    },
    website_traffic: {
        description: "Hourly website visits: daily + weekly seasonality with a growth trend.",
        frequency: "hourly",
        series: {
            baseline: 500,
            trend: "linear",
            trendStrength: 0.5,
            seasonality: [
                { period: 24, amplitude: 300 },
                { period: 168, amplitude: 150 },
            ],
            noiseLevel: 60,
            min: 0,
            integer: true,
        },
    },
    stock_price: {
        description: "Daily stock-like price: persistent random-walk drift with volatility, no seasonality.",
        frequency: "daily",
        series: {
            baseline: 100,
            noise: "ar1",
            ar1Phi: 0.95,
            noiseLevel: 2,
            min: 0,
        },
    },
    api_latency_ms: {
        description: "Per-minute API latency (ms): low baseline with frequent latency spikes.",
        frequency: "minutely",
        series: {
            baseline: 80,
            noiseLevel: 15,
            anomalies: [{ type: "spike", count: 10, magnitude: 6 }],
            min: 0,
        },
    },
};
