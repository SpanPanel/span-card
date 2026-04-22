import { LitElement, html, css } from "lit";
import { property } from "lit/decorators.js";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { EChartsType } from "echarts/core";
import type { BuildChartResult } from "./chart-options.js";

// Register only the pieces we use. Tree-shakes the rest of ECharts so
// the bundle stays as small as possible. SVG renderer (vs Canvas) is
// the right pick for shadow-DOM cards: SVG paints natively into the
// shadow root with no global stylesheet dependency, which is exactly
// the constraint that makes ApexCharts brittle here.
echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

type ChartOptions = BuildChartResult["options"];
type ChartSeries = BuildChartResult["series"];

/**
 * Replacement for HA's <ha-chart-base>. Owns the lifecycle of an
 * ECharts instance bound to a div in the element's shadow root.
 *
 * ECharts is the same charting library HA uses inside ha-chart-base,
 * picked here because it renders cleanly inside Lit shadow roots
 * (pure SVG, no reliance on global stylesheets) — ApexCharts
 * specifically struggles with shadow-DOM size detection and CSS
 * scoping, which made it unworkable for this card.
 *
 * Lifecycle:
 *   firstUpdated  – init the chart on the host div with the first
 *                   options + series.
 *   updated       – setOption with the merged options on subsequent
 *                   property changes; the second argument ``true``
 *                   tells ECharts to replace (not merge) so removing
 *                   a series actually removes it.
 *   resize        – ResizeObserver on the host calls chart.resize()
 *                   so the SVG re-flows to the new dimensions.
 *   disconnected  – dispose the ECharts instance and disconnect the
 *                   observer so hidden tabs don't leak chart instances.
 */
export class SpanChart extends LitElement {
  @property({ attribute: false }) options: ChartOptions | null = null;
  @property({ attribute: false }) data: ChartSeries = [];
  @property({ type: String }) height = "120px";

  private _chart: EChartsType | null = null;
  private _resizeObserver: ResizeObserver | null = null;

  static override styles = css`
    :host {
      display: block;
      width: 100%;
    }
    .chart-host {
      width: 100%;
      height: 100%;
    }
  `;

  protected override render(): unknown {
    return html`<div class="chart-host" style="height:${this.height};"></div>`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // If the element is being reattached after a previous disconnect
    // (e.g. moved between DOM positions, adoptNode), firstUpdated has
    // already run and won't run again. Re-mount the chart so the live
    // SVG comes back.
    if (this.hasUpdated && !this._chart && this.options) {
      this._mount();
      this._observeResize();
    }
  }

  protected override firstUpdated(): void {
    this._mount();
    this._observeResize();
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("options") || changed.has("data")) {
      if (this._chart && this.options) {
        // ECharts' setOption takes its loose ECBasicOption shape; our
        // strongly-typed ChartOptionsDef is structurally compatible but
        // not assignable without a cast at the boundary.
        this._chart.setOption(this._mergedOptions() as unknown as Parameters<EChartsType["setOption"]>[0], true);
      } else if (!this._chart && this.options) {
        // Late-arriving options: firstUpdated already ran but options
        // wasn't set yet so _mount bailed. Mount now that we have a
        // valid option set. Without this branch the chart would stay
        // permanently blank for any caller that assigns options after
        // the first Lit update cycle.
        this._mount();
      }
    }
    if (changed.has("height") && this._chart) {
      this._chart.resize();
    }
  }

  disconnectedCallback(): void {
    this._destroy();
    super.disconnectedCallback();
  }

  private _mount(): void {
    if (!this.options) return;
    const host = this.shadowRoot?.querySelector(".chart-host") as HTMLElement | null;
    if (!host) return;
    this._chart = echarts.init(host, undefined, { renderer: "svg" });
    // ECharts' setOption takes its loose ECBasicOption shape; our
    // strongly-typed ChartOptionsDef is structurally compatible but
    // not assignable without a cast at the boundary.
    this._chart.setOption(this._mergedOptions() as unknown as Parameters<EChartsType["setOption"]>[0], true);
  }

  private _mergedOptions(): ChartOptions & { series: ChartSeries } {
    if (!this.options) throw new Error("span-chart: options not set");
    return { ...this.options, series: this.data };
  }

  private _observeResize(): void {
    if (typeof ResizeObserver === "undefined") return;
    this._resizeObserver = new ResizeObserver(() => {
      if (this._chart) this._chart.resize();
    });
    const host = this.shadowRoot?.querySelector(".chart-host") as HTMLElement | null;
    if (host) this._resizeObserver.observe(host);
  }

  private _destroy(): void {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._chart) {
      this._chart.dispose();
      this._chart = null;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "span-chart": SpanChart;
  }
}

// Guarded registration: see span-icon.ts for the rationale.
try {
  if (!customElements.get("span-chart")) {
    customElements.define("span-chart", SpanChart);
  }
} catch {
  // Scoped custom element registry may throw on duplicate registration after upgrade
}
