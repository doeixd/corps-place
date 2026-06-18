#!/usr/bin/env python3
"""Generate a self-contained HTML viewer for referenceCurvesV4.json."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


DEFAULT_CURVES = Path("src/training/referenceCurvesV4.json")
DEFAULT_DB = Path("dci-relational.db")
DEFAULT_OUT = Path("results/reference-curves-v4.html")
CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"]
PLOT_METRICS = [*CAPTIONS, "TOTAL"]
DIVISIONS = ["World Class", "Open Class"]
RANKS = list(range(1, 26))
BUCKETS = list(range(0, 101, 5))


def interpolate(points: list[tuple[int, dict]], bucket: int) -> dict | None:
    lower = None
    upper = None
    for point_bucket, value in points:
        if point_bucket < bucket:
            lower = (point_bucket, value)
        elif point_bucket > bucket and upper is None:
            upper = (point_bucket, value)

    if lower and upper:
        p1, v1 = lower
        p2, v2 = upper
        t = (bucket - p1) / (p2 - p1)
        return {
            "min": round(v1["min"] + (v2["min"] - v1["min"]) * t, 3),
            "max": round(v1["max"] + (v2["max"] - v1["max"]) * t, 3),
            "count": 0,
        }
    if lower:
        return {"min": lower[1]["min"], "max": lower[1]["max"], "count": 0}
    if upper:
        return {"min": upper[1]["min"], "max": upper[1]["max"], "count": 0}
    return None


def build_range_data(db_path: Path) -> dict:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        SELECT
          division_name,
          rank_bucket,
          percent_bucket,
          metric_name,
          min_score,
          max_score,
          sample_count
        FROM reference_curve_metric_stats
        """
    ).fetchall()
    observed_rows = con.execute("SELECT COUNT(*) AS count FROM clean_reference_curve_entries").fetchone()["count"]
    con.close()

    stats: dict[str, dict[str, dict[str, float | int]]] = {}
    for raw in rows:
        row = dict(raw)
        key = f"{row['division_name']}|{row['rank_bucket']}-{row['percent_bucket']}"
        stats.setdefault(key, {})
        stats[key][row["metric_name"]] = {
            "min": round(float(row["min_score"]), 3),
            "max": round(float(row["max_score"]), 3),
            "count": int(row["sample_count"]),
        }

    for division in DIVISIONS:
        for rank in RANKS:
            for metric in PLOT_METRICS:
                points = []
                for bucket in BUCKETS:
                    value = stats.get(f"{division}|{rank}-{bucket}", {}).get(metric)
                    if value:
                        points.append((bucket, value))
                for bucket in BUCKETS:
                    key = f"{division}|{rank}-{bucket}"
                    stats.setdefault(key, {})
                    if metric in stats[key]:
                        continue
                    filled = interpolate(points, bucket)
                    if filled:
                        stats[key][metric] = filled

    for division in DIVISIONS:
        for rank in RANKS:
            for bucket in BUCKETS:
                key = f"{division}|{rank}-{bucket}"
                stats.setdefault(key, {})
                for metric in PLOT_METRICS:
                    if metric in stats[key]:
                        continue
                    nearest = None
                    for distance in range(1, len(RANKS)):
                        lower = stats.get(f"{division}|{rank - distance}-{bucket}", {}).get(metric)
                        upper = stats.get(f"{division}|{rank + distance}-{bucket}", {}).get(metric)
                        if lower:
                            nearest = lower
                            break
                        if upper:
                            nearest = upper
                            break
                    if nearest:
                        stats[key][metric] = {"min": nearest["min"], "max": nearest["max"], "count": 0}

    return {
        "metrics": PLOT_METRICS,
        "observed_rows": observed_rows,
        "stats": stats,
    }


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DCI Reference Curves</title>
  <style>
    :root {{
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f8fa;
      color: #1b1f24;
    }}
    body {{
      margin: 0;
    }}
    header {{
      padding: 18px 24px 12px;
      border-bottom: 1px solid #d8dee6;
      background: #ffffff;
    }}
    h1 {{
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0;
    }}
    .meta {{
      margin-top: 6px;
      color: #5c6773;
      font-size: 13px;
    }}
    main {{
      padding: 18px 24px 28px;
      max-width: 1320px;
      margin: 0 auto;
    }}
    .toolbar {{
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 12px;
      align-items: end;
      margin-bottom: 16px;
    }}
    label {{
      display: grid;
      gap: 5px;
      font-size: 12px;
      font-weight: 650;
      color: #3b4652;
    }}
    select, input[type="range"] {{
      width: 100%;
    }}
    select {{
      height: 34px;
      border: 1px solid #b8c2cc;
      border-radius: 6px;
      background: white;
      color: #1b1f24;
      padding: 0 8px;
      font-size: 14px;
    }}
    .rank-row {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      padding: 10px 0 18px;
      font-size: 13px;
    }}
    .rank-row label {{
      display: inline-flex;
      grid-template-columns: none;
      align-items: center;
      gap: 6px;
      font-weight: 500;
    }}
    .grid {{
      display: grid;
      grid-template-columns: 1fr;
      gap: 18px;
    }}
    .panel {{
      background: #ffffff;
      border: 1px solid #d8dee6;
      border-radius: 8px;
      padding: 14px;
    }}
    .panel h2 {{
      margin: 0 0 10px;
      font-size: 15px;
      font-weight: 700;
    }}
    canvas {{
      display: block;
      width: 100%;
      height: 430px;
    }}
    .readout {{
      margin-top: 8px;
      color: #5c6773;
      font-size: 13px;
      white-space: pre-wrap;
    }}
    @media (max-width: 760px) {{
      .toolbar {{
        grid-template-columns: 1fr 1fr;
      }}
      canvas {{
        height: 340px;
      }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>DCI Reference Curves</h1>
    <div class="meta" id="meta"></div>
  </header>
  <main>
    <section class="toolbar">
      <label>
        Division
        <select id="division"></select>
      </label>
      <label>
        Caption
        <select id="caption"></select>
      </label>
      <label>
        Percent Through: <span id="bucketLabel">100</span>%
        <input id="bucket" type="range" min="0" max="100" step="5" value="100" />
      </label>
      <label>
        Y Scale
        <select id="scale">
          <option value="caption">Caption score scale</option>
          <option value="total">Approx total contribution scale</option>
        </select>
      </label>
    </section>

    <section>
      <div class="rank-row" id="rankControls"></div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Selected Ranks Over Season Progress</h2>
        <canvas id="progressChart"></canvas>
        <div class="readout" id="progressReadout"></div>
      </div>
      <div class="panel">
        <h2>All Ranks At Selected Season Progress</h2>
        <canvas id="rankChart"></canvas>
        <div class="readout" id="rankReadout"></div>
      </div>
    </section>
  </main>

  <script>
    const DATA = __DATA__;
    const RANGE_DATA = __RANGE_DATA__;
    const CURVES = DATA.curves;
    const CAPTIONS = DATA.captions || ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"];
    const METRICS = [...CAPTIONS, "TOTAL"];
    const DIVISIONS = DATA.divisions || ["World Class", "Open Class"];
    const RANKS = Array.from({ length: 25 }, (_, i) => i + 1);
    const BUCKETS = Array.from({ length: 21 }, (_, i) => i * 5);
    const DEFAULT_RANKS = new Set([1, 3, 6, 12, 18, 25]);
    const COLORS = [
      "#0f6b99", "#bc4b51", "#2a9d8f", "#7b2cbf", "#f77f00", "#536dfe",
      "#2d6a4f", "#9d0208", "#6c757d", "#8a5a44", "#118ab2", "#ef476f"
    ];

    const el = (id) => document.getElementById(id);
    const divisionEl = el("division");
    const captionEl = el("caption");
    const bucketEl = el("bucket");
    const scaleEl = el("scale");
    const bucketLabelEl = el("bucketLabel");

    function initControls() {{
      el("meta").textContent = `version=${{DATA.version || "unknown"}} | dimensions=${{(DATA.dimensions || []).join(" / ")}} | range rows=${{RANGE_DATA.observed_rows}}`;
      for (const division of DIVISIONS) {{
        const option = document.createElement("option");
        option.value = division;
        option.textContent = division;
        divisionEl.appendChild(option);
      }}
      for (const caption of METRICS) {{
        const option = document.createElement("option");
        option.value = caption;
        option.textContent = caption === "TOTAL" ? "Overall Total" : caption;
        captionEl.appendChild(option);
      }}
      const rankControls = el("rankControls");
      for (const rank of RANKS) {{
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = String(rank);
        input.checked = DEFAULT_RANKS.has(rank);
        input.addEventListener("change", draw);
        label.appendChild(input);
        label.appendChild(document.createTextNode(`Rank ${{rank}}`));
        rankControls.appendChild(label);
      }}
      for (const control of [divisionEl, captionEl, bucketEl, scaleEl]) {{
        control.addEventListener("input", draw);
        control.addEventListener("change", draw);
      }}
    }}

    function selectedRanks() {{
      return Array.from(document.querySelectorAll("#rankControls input:checked"))
        .map((input) => Number(input.value));
    }}

    function curveValue(division, rank, bucket, caption) {{
      if (caption === "TOTAL") {{
        const row = CURVES[`${{division}}|${{rank}}-${{bucket}}`];
        if (!row) return undefined;
        return row.GE1 + row.GE2 + ((row.VP + row.VA + row.CG) / 2) + ((row.MB + row.MA + row.MP) / 2);
      }}
      const row = CURVES[`${{division}}|${{rank}}-${{bucket}}`];
      return row ? row[caption] : undefined;
    }}

    function rangeValue(division, rank, bucket, caption) {{
      const row = RANGE_DATA.stats[`${{division}}|${{rank}}-${{bucket}}`];
      return row ? row[caption] : undefined;
    }}

    function valueForScale(value, caption) {{
      if (!Number.isFinite(value)) return undefined;
      if (caption === "TOTAL") return value;
      if (scaleEl.value === "caption") return value;
      if (caption === "GE1" || caption === "GE2") return value;
      return value / 2;
    }}

    function resizeCanvas(canvas) {{
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return {{ ctx, width: rect.width, height: rect.height }};
    }}

    function drawAxes(ctx, width, height, xMin, xMax, yMin, yMax, xLabel, yLabel) {{
      const pad = {{ left: 52, right: 18, top: 22, bottom: 44 }};
      const plot = {{
        x: pad.left,
        y: pad.top,
        w: width - pad.left - pad.right,
        h: height - pad.top - pad.bottom
      }};
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "#d8dee6";
      ctx.lineWidth = 1;
      ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

      ctx.fillStyle = "#5c6773";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(xLabel, plot.x + plot.w / 2, height - 10);
      ctx.save();
      ctx.translate(14, plot.y + plot.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();

      ctx.strokeStyle = "#eef1f4";
      ctx.fillStyle = "#5c6773";
      ctx.textAlign = "right";
      for (let i = 0; i <= 5; i++) {{
        const y = plot.y + (plot.h * i) / 5;
        const val = yMax - ((yMax - yMin) * i) / 5;
        ctx.beginPath();
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.w, y);
        ctx.stroke();
        ctx.fillText(val.toFixed(1), plot.x - 7, y + 4);
      }}

      ctx.textAlign = "center";
      for (let i = 0; i <= 5; i++) {{
        const x = plot.x + (plot.w * i) / 5;
        const val = xMin + ((xMax - xMin) * i) / 5;
        ctx.fillText(Math.round(val), x, plot.y + plot.h + 18);
      }}

      return {{
        plot,
        tx: (x) => plot.x + ((x - xMin) / (xMax - xMin)) * plot.w,
        ty: (y) => plot.y + plot.h - ((y - yMin) / (yMax - yMin)) * plot.h
      }};
    }}

    function valueRange(series) {{
      const values = series
        .flatMap((entry) => entry.points.flatMap((point) => [point.y, point.min, point.max]))
        .filter(Number.isFinite);
      if (!values.length) return [0, 20];
      let min = Math.min(...values);
      let max = Math.max(...values);
      const span = Math.max(0.5, max - min);
      min = Math.max(0, min - span * 0.12);
      max = Math.min(captionEl.value === "TOTAL" ? 100 : 20, max + span * 0.12);
      if (Math.abs(max - min) < 0.5) max = min + 0.5;
      return [min, max];
    }}

    function drawLineChart(canvas, series, xMin, xMax, xLabel, yLabel) {{
      const {{ ctx, width, height }} = resizeCanvas(canvas);
      const [yMin, yMax] = valueRange(series);
      const axes = drawAxes(ctx, width, height, xMin, xMax, yMin, yMax, xLabel, yLabel);
      series.forEach((entry, idx) => {{
        const bandPoints = entry.points.filter((point) => Number.isFinite(point.min) && Number.isFinite(point.max));
        if (bandPoints.length > 1) {{
          ctx.fillStyle = entry.bandColor || `${{COLORS[idx % COLORS.length]}}26`;
          ctx.beginPath();
          bandPoints.forEach((point, i) => {{
            const x = axes.tx(point.x);
            const y = axes.ty(point.max);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }});
          [...bandPoints].reverse().forEach((point) => {{
            ctx.lineTo(axes.tx(point.x), axes.ty(point.min));
          }});
          ctx.closePath();
          ctx.fill();
        }}

        ctx.strokeStyle = COLORS[idx % COLORS.length];
        ctx.fillStyle = COLORS[idx % COLORS.length];
        ctx.lineWidth = 2;
        ctx.beginPath();
        entry.points.forEach((point, i) => {{
          const x = axes.tx(point.x);
          const y = axes.ty(point.y);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }});
        ctx.stroke();
        const last = entry.points[entry.points.length - 1];
        if (last) {{
          ctx.font = "12px system-ui, sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(entry.label, axes.tx(last.x) + 5, axes.ty(last.y) + 4);
        }}
      }});
    }}

    function draw() {{
      bucketLabelEl.textContent = bucketEl.value;
      const division = divisionEl.value;
      const caption = captionEl.value;
      const bucket = Number(bucketEl.value);
      const ranks = selectedRanks();

      const progressSeries = ranks.map((rank) => ({{
        label: `R${{rank}}`,
        points: BUCKETS.map((b) => ({{
          x: b,
          y: valueForScale(curveValue(division, rank, b, caption), caption),
          min: valueForScale(rangeValue(division, rank, b, caption)?.min, caption),
          max: valueForScale(rangeValue(division, rank, b, caption)?.max, caption),
          count: rangeValue(division, rank, b, caption)?.count ?? 0
        }}))
      }}));
      drawLineChart(el("progressChart"), progressSeries, 0, 100, "percent through season", caption === "TOTAL" ? "expected total" : "expected score");

      const rankSeries = [{{
        label: `${{caption}} @ ${{bucket}}%`,
        points: RANKS.map((rank) => ({{
          x: rank,
          y: valueForScale(curveValue(division, rank, bucket, caption), caption),
          min: valueForScale(rangeValue(division, rank, bucket, caption)?.min, caption),
          max: valueForScale(rangeValue(division, rank, bucket, caption)?.max, caption),
          count: rangeValue(division, rank, bucket, caption)?.count ?? 0
        }}))
      }}];
      drawLineChart(el("rankChart"), rankSeries, 1, 25, "rank", caption === "TOTAL" ? "expected total" : "expected score");

      const selectedReadout = ranks.map((rank) => {{
        const start = valueForScale(curveValue(division, rank, 0, caption), caption);
        const end = valueForScale(curveValue(division, rank, 100, caption), caption);
        const band = rangeValue(division, rank, bucket, caption);
        const min = valueForScale(band?.min, caption);
        const max = valueForScale(band?.max, caption);
        const count = band?.count ?? 0;
        return `R${{rank}}: 0%=${{start.toFixed(3)}} 100%=${{end.toFixed(3)}} delta=${{(end - start).toFixed(3)}} | @${{bucket}}% min=${{min?.toFixed(3)}} max=${{max?.toFixed(3)}} n=${{count}}`;
      }}).join("\\n");
      el("progressReadout").textContent = selectedReadout;

      const top = valueForScale(curveValue(division, 1, bucket, caption), caption);
      const mid = valueForScale(curveValue(division, 12, bucket, caption), caption);
      const low = valueForScale(curveValue(division, 25, bucket, caption), caption);
      const topBand = rangeValue(division, 1, bucket, caption);
      const lowBand = rangeValue(division, 25, bucket, caption);
      el("rankReadout").textContent =
        `At ${{bucket}}%: R1=${{top.toFixed(3)}} R12=${{mid.toFixed(3)}} R25=${{low.toFixed(3)}} spread=${{(top - low).toFixed(3)}}` +
        `\\nR1 observed band: ${{valueForScale(topBand?.min, caption)?.toFixed(3)}} - ${{valueForScale(topBand?.max, caption)?.toFixed(3)}} n=${{topBand?.count ?? 0}}` +
        `\\nR25 observed band: ${{valueForScale(lowBand?.min, caption)?.toFixed(3)}} - ${{valueForScale(lowBand?.max, caption)?.toFixed(3)}} n=${{lowBand?.count ?? 0}}`;
    }}

    window.addEventListener("resize", draw);
    initControls();
    draw();
  </script>
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Build reference curve HTML viewer.")
    parser.add_argument("--curves", type=Path, default=DEFAULT_CURVES)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    data = json.loads(args.curves.read_text(encoding="utf-8"))
    range_data = build_range_data(args.db)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    template = HTML_TEMPLATE.replace("{{", "{").replace("}}", "}")
    html = template.replace("__DATA__", json.dumps(data, separators=(",", ":")))
    html = html.replace("__RANGE_DATA__", json.dumps(range_data, separators=(",", ":")))
    args.out.write_text(html, encoding="utf-8")
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
