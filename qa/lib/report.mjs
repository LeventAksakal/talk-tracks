// The run's report.md: every capture with its intent and console errors, every failed step, the Lighthouse table
// and the trace numbers. Everything passes through the redactor so the deployed host never lands in a file.

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function writeReport({ meta, capture, lighthouse, trace, redact }) {
  const L = [];
  L.push(`# QA run ${meta.run}`, "");
  L.push(`- Base: \`${meta.baseShown}\``);
  L.push(`- Started: ${meta.started} · finished: ${meta.finished} · ${meta.minutes} min`);
  L.push(`- Journeys: ${meta.journeys.join(", ")} · themes: ${meta.themes.join(", ")} · viewport 1440×900 @1x, reduced motion`);
  L.push(`- Demo room: \`${meta.room}\` · trace page: \`${meta.tracePath}\``);
  const b = meta.builds ?? {};
  const seen = new Set(
    [b.start, b.lighthouse, b.trace, b.end, ...(capture?.browsers ?? []).flatMap((x) => [x.build, x.buildEnd])].filter(Boolean),
  );
  L.push(`- Build (entry script): start \`${b.start ?? "?"}\`, Lighthouse \`${b.lighthouse ?? "–"}\`, trace \`${b.trace ?? "–"}\`, end \`${b.end ?? "?"}\``);
  if (seen.size > 1)
    L.push(
      "",
      `> **The site was redeployed during this run** (${seen.size} builds seen: ${[...seen].map((s) => `\`${s}\``).join(", ")}).`,
      "> Compare the Build column below before reading a difference between browsers as a browser difference.",
    );
  L.push("");
  L.push(
    "Captures are evidence, not assertions: nothing here passes or fails on pixels. Live rooms change between runs",
    "(no injected clock or seed), so two runs are not byte-comparable; read frames against their intent.",
    "",
  );

  if (capture) {
    L.push("## Browsers", "", "| Browser | Status | Version | Build (start → end) | Captures | Failed steps | Skipped steps |", "|---|---|---|---|---|---|---|");
    for (const br of capture.browsers) {
      const caps = capture.captures.filter((c) => c.browser === br.name && c.file).length;
      const fails = capture.failures.filter((f) => f.browser === br.name && !f.skipped).length;
      const skips = capture.failures.filter((f) => f.browser === br.name && f.skipped).length;
      const build = br.build ? (br.buildEnd && br.buildEnd !== br.build ? `${br.build} → **${br.buildEnd}**` : br.build) : "";
      L.push(`| ${br.name} | ${cell(br.status)} | ${cell(br.version)} | ${build} | ${caps} | ${fails} | ${skips} |`);
    }
    L.push("");

    const failed = capture.failures.filter((f) => !f.skipped);
    L.push(`## Failed steps (${failed.length})`, "");
    if (failed.length) {
      L.push("| Browser | Theme | Journey | Step | Error |", "|---|---|---|---|---|");
      for (const f of failed) L.push(`| ${f.browser} | ${f.theme ?? ""} | ${f.journey} | ${cell(f.step)} | ${cell(f.error)} |`);
    } else L.push("None.");
    L.push("");
    const skipped = capture.failures.filter((f) => f.skipped);
    if (skipped.length) {
      L.push(`## Skipped steps (${skipped.length})`, "", "Skipped on purpose (cost guard or the room lacks the feature).", "");
      L.push("| Browser | Theme | Journey | Step | Why |", "|---|---|---|---|---|");
      for (const f of skipped) L.push(`| ${f.browser} | ${f.theme ?? ""} | ${f.journey} | ${cell(f.step)} | ${cell(f.error.replace(/^skipped:\s*/, ""))} |`);
      L.push("");
    }

    const withErrors = capture.captures.filter((c) => c.errors.length);
    L.push(`## Console errors (${withErrors.reduce((n, c) => n + c.errors.length, 0)} across ${withErrors.length} captures)`, "");
    if (withErrors.length) {
      // Group identical messages so a repeated error reads once with its count and where it appeared.
      const groups = new Map();
      for (const c of withErrors)
        for (const e of c.errors) {
          const key = e.replace(/\d+(\.\d+)?/g, "N");
          const g = groups.get(key) ?? { text: e, count: 0, where: new Set() };
          g.count++;
          g.where.add(`${c.browser}/${c.journey}`);
          groups.set(key, g);
        }
      L.push("| Count | Message | Where |", "|---|---|---|");
      for (const g of [...groups.values()].sort((a, b) => b.count - a.count))
        L.push(`| ${g.count} | ${cell(g.text.slice(0, 220))} | ${[...g.where].slice(0, 6).join(", ")}${g.where.size > 6 ? " …" : ""} |`);
    } else L.push("None.");
    L.push("");
  }

  if (lighthouse) {
    L.push("## Lighthouse (desktop preset)", "");
    L.push("| Page | Path | Performance | Accessibility | Best practices | SEO | LCP | CLS | TBT | Reports |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const r of lighthouse) {
      if (r.error) {
        L.push(`| ${r.id} | \`${r.path}\` | error: ${cell(r.error)} | | | | | | | |`);
        continue;
      }
      const s = r.scores;
      L.push(
        `| ${r.id} | \`${r.path}\` | ${s.performance ?? "–"} | ${s.accessibility ?? "–"} | ${s["best-practices"] ?? "–"} | ${s.seo ?? "–"} | ${r.metrics.lcp} | ${r.metrics.cls} | ${r.metrics.tbt} | [html](${r.files.html}) · [json](${r.files.json}) |`,
      );
    }
    L.push("");
    for (const r of lighthouse.filter((x) => !x.error)) {
      if (r.runtimeError || r.warnings.length) L.push(`- ${r.id}: ${cell(r.runtimeError ?? "")} ${r.warnings.map(cell).join("; ")}`);
      if (r.failing.length) L.push(`- ${r.id} audits under 90: ${r.failing.map((a) => `${a.title} (${Math.round(a.score * 100)})`).join("; ")}`);
    }
    L.push("");
  }

  if (trace) {
    L.push("## Performance trace", "");
    L.push(`Page \`${trace.path}\` in ${trace.browser}: load, ${trace.seconds} s of playback with subtitles, a seek back a minute, then Go live.`);
    if (trace.file) L.push(`Trace: [${trace.file}](${trace.file}) (open in the DevTools Performance panel).`);
    if (trace.error) L.push("", `**Trace failed:** ${cell(trace.error)}`);
    L.push("");
    if (trace.steps?.length) {
      L.push("| Step | OK | Note |", "|---|---|---|");
      for (const s of trace.steps) L.push(`| ${s.name} | ${s.ok ? "yes" : "**no**"} | ${cell(s.note)} |`);
      L.push("");
    }
    const ph = trace.analysis?.phases ?? [];
    if (ph.length) {
      L.push("| Phase | Seconds | Main-thread busy | Long tasks (>50 ms) | Long-task total | Longest | Frames drawn /s | JS heap start → end (MB) |", "|---|---|---|---|---|---|---|---|");
      for (const p of ph)
        L.push(
          p.missing
            ? `| ${p.name} | – | mark missing | | | | | |`
            : `| ${p.name} | ${p.seconds} | ${p.busyShare} % | ${p.longTasks} | ${p.longTaskMsTotal} ms | ${p.longestTaskMs} ms | ${p.compositorFps ?? "–"} | ${p.heapStartMB ?? "–"} → ${p.heapEndMB ?? "–"} |`,
        );
      L.push(
        "",
        "Frames drawn /s counts compositor DrawFrame events: frames with new content, so a still slide draws few. The",
        "requestAnimationFrame rate below is the page's paint opportunities and follows the display (headless may exceed 60).",
        "",
      );
    }
    if (trace.raf) L.push(`- requestAnimationFrame during playback: ${trace.raf.fps} fps over ${trace.raf.frames} frames, p95 frame ${trace.raf.p95FrameMs} ms, ${trace.raf.framesOver50ms} frames over 50 ms.`);
    if (trace.video?.length) L.push(`- Video elements: ${trace.video.map((v) => `${v.w}×${v.h} ${v.paused ? "paused" : "playing"}, ${v.total ?? "?"} frames, ${v.dropped ?? "?"} dropped`).join("; ")}.`);
    else if (trace.video) L.push("- No <video> element on the page during playback.");
    if (trace.heap?.length > 1) {
      const a = trace.heap[0];
      const b = trace.heap.at(-1);
      const mins = (b.t - a.t) / 60;
      L.push(`- JS heap after GC: ${a.usedMB} MB → ${b.usedMB} MB over ${b.t - a.t} s (${(((b.usedMB - a.usedMB) / (mins || 1))).toFixed(2)} MB/min); DOM nodes ${a.nodes} → ${b.nodes}; listeners ${a.listeners} → ${b.listeners}.`);
      L.push(`- Heap samples (MB, every 5 s): ${trace.heap.map((h) => h.usedMB).join(", ")}.`);
    }
    if (trace.pillDuring) L.push(`- Time pill at the end of playback: "${cell(trace.pillDuring)}".`);
    if (trace.errors?.length) L.push(`- Console errors during the trace: ${trace.errors.length} (first: ${cell(trace.errors[0])}).`);
    L.push("");
  }

  if (capture) {
    L.push("## Captures", "");
    const order = [...new Set(capture.captures.map((c) => c.browser))];
    for (const b of order) {
      const rows = capture.captures.filter((c) => c.browser === b);
      L.push(`### ${b} (${rows.filter((r) => r.file).length})`, "", "| Capture | Intent | Console errors |", "|---|---|---|");
      for (const c of rows) {
        const link = c.file ? `[${c.file.split("/").pop()}](${c.file})` : `${c.journey} ${c.state}`;
        const errs = c.errors.length ? `${c.errors.length}: ${cell(c.errors[0].slice(0, 140))}` : "";
        L.push(`| ${link} | ${cell(c.intent)} | ${errs} |`);
      }
      L.push("");
    }
    if (capture.timings.length) {
      L.push("## Journey timings", "", "| Browser | Theme | Journey | Seconds |", "|---|---|---|---|");
      for (const t of capture.timings) L.push(`| ${t.browser} | ${t.theme} | ${t.journey} | ${t.seconds} |`);
      L.push("");
    }
  }
  return redact(L.join("\n"));
}
