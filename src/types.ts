export type Frequency =
  | "secondly"
  | "minutely"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly";

export type TrendType = "none" | "linear" | "exponential" | "logistic";
export type NoiseType = "gaussian" | "ar1";
export type OutputFormat = "json" | "csv" | "sql";
export type AnomalyType = "spike" | "level_shift" | "trend_change" | "dropout";

export interface SeasonalityComponent {
  period: number; // in points
  amplitude: number;
  phase?: number; // radians, default 0
}

export interface AnomalySpec {
  type: AnomalyType;
  at?: number; // index; if omitted, random position(s)
  magnitude?: number; // multiplier relative to noise std / baseline
  count?: number; // number of occurrences (spike/dropout)
}

export interface SeriesSpec {
  name?: string;
  baseline?: number;
  trend?: TrendType;
  trendStrength?: number;
  seasonality?: SeasonalityComponent[];
  noise?: NoiseType;
  noiseLevel?: number;
  ar1Phi?: number;
  anomalies?: AnomalySpec[];
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface GenerateOptions {
  length: number;
  frequency: Frequency;
  start?: string; // ISO start timestamp
  series: SeriesSpec[];
  correlation?: number; // 0..1 target pairwise correlation across series
  seed?: number;
  tableName?: string;
}

export interface GeneratedPoint {
  timestamp: string;
  values: Record<string, number>;
}

export interface GenerateResult {
  points: GeneratedPoint[];
  seriesNames: string[];
  frequency: Frequency;
}
