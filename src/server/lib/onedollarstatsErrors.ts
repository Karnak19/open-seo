type OneDollarStatsErrorCode =
  | "validation_error"
  | "onedollarstats_not_connected"
  | "onedollarstats_key_rejected"
  | "onedollarstats_rate_limited"
  | "onedollarstats_unreachable"
  | "onedollarstats_malformed_response";

/** Every OneDollarStats failure, from the HTTP client up through the reports.
 *  Messages never carry the API key or response bodies. */
export class OneDollarStatsError extends Error {
  constructor(
    public readonly code: OneDollarStatsErrorCode,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "OneDollarStatsError";
  }
}
