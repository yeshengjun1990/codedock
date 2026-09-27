/**
 * Metrics tracking for MCP requests.
 *
 * Distinguishes local execution time (service_ms) from outside-WebCodex time
 * (next_call_gap_ms = network + AI thinking/reasoning), plus full cycle time.
 */

const MAX_HISTORY = 40;

class MetricsTracker {
  constructor() {
    this.lastResponseEndedAt = null;
    this.history = [];
    this.inFlight = 0;
    this.totals = {
      requests: 0,
      totalServiceMs: 0,
      totalGapMs: 0,
    };
  }

  /**
   * Called when a request arrives.
   * Returns a session object with a finish(toolName) callback.
   */
  startRequest(method, toolName) {
    const recvAt = Date.now();
    // A gap is only meaningful when the client was actually idle. With other
    // requests still in flight (agents fire tool calls in parallel), the time
    // since the previous response says nothing about AI thinking time, so
    // report null instead of a bogus near-zero value.
    const gapMs =
      this.inFlight === 0 && this.lastResponseEndedAt != null
        ? Math.max(0, recvAt - this.lastResponseEndedAt)
        : null;
    this.inFlight += 1;

    return {
      recvAt,
      gapMs,
      finish: (finalToolName) => {
        const respAt = Date.now();
        this.inFlight = Math.max(0, this.inFlight - 1);
        const serviceMs = Math.max(0, respAt - recvAt);
        const cycleMs = gapMs != null ? serviceMs + gapMs : serviceMs;
        this.lastResponseEndedAt = respAt;

        const record = {
          method,
          tool: finalToolName || toolName,
          at: respAt,
          serviceMs,
          gapMs,
          cycleMs,
        };

        this.history.push(record);
        if (this.history.length > MAX_HISTORY) this.history.shift();

        this.totals.requests += 1;
        this.totals.totalServiceMs += serviceMs;
        if (gapMs != null) this.totals.totalGapMs += gapMs;

        return record;
      },
    };
  }

  summary() {
    if (!this.history.length) {
      return {
        requests: 0,
        avgServiceMs: 0,
        avgGapMs: 0,
        lastGapMs: 0,
        lastServiceMs: 0,
      };
    }

    const n = this.history.length;
    const avgServiceMs = Math.round(
      this.history.reduce((acc, h) => acc + h.serviceMs, 0) / n
    );
    const gaps = this.history.filter((h) => h.gapMs != null);
    const avgGapMs = gaps.length
      ? Math.round(gaps.reduce((acc, h) => acc + h.gapMs, 0) / gaps.length)
      : 0;
    const last = this.history[this.history.length - 1];

    return {
      requests: this.totals.requests,
      avgServiceMs,
      avgGapMs,
      lastGapMs: last.gapMs || 0,
      lastServiceMs: last.serviceMs,
    };
  }
}

const metrics = new MetricsTracker();
metrics.MetricsTracker = MetricsTracker;
module.exports = metrics;

