import type {
  FindingsStore,
  IterationPipelineInput,
  IterationPipelineResult,
} from '@monoceros/core';
import { runIterationPipeline } from '@monoceros/core';

export interface IterateDeps {
  /**
   * Pipeline runner. Defaults to the real
   * `runIterationPipeline`; tests inject a stub returning a canned
   * result.
   */
  pipeline?: (
    input: IterationPipelineInput,
  ) => Promise<IterationPipelineResult>;
}

export interface IterateOutcome {
  iterationId: string;
  result: IterationPipelineResult;
  appendedFindingIds: string[];
  appendedConcernIds: string[];
  appendedRiskIds: string[];
}

/**
 * Runs the iteration pipeline and fans the structured outputs into
 * the FindingsStore: one iteration-audit entry, one finding per
 * Reviewer finding, one concern per Generator concern, one risk per
 * Planner risk.
 *
 * Both success and failure cases write an iteration-audit entry —
 * the audit is the complete record of the run regardless of which
 * phase terminated it.
 */
export async function runIterateCommand(
  store: FindingsStore,
  input: IterationPipelineInput,
  deps: IterateDeps = {},
): Promise<IterateOutcome> {
  const pipeline = deps.pipeline ?? runIterationPipeline;
  const result = await pipeline(input);

  const iterationId = await store.appendIteration(
    buildAuditInput(input, result),
  );

  const appendedFindingIds: string[] = [];
  const appendedConcernIds: string[] = [];
  const appendedRiskIds: string[] = [];

  if (result.ok) {
    for (const finding of result.reviewReport.findings) {
      const id = await store.appendFinding({
        sourceIteration: iterationId,
        finding,
      });
      appendedFindingIds.push(id);
    }
    for (const concern of result.generatorReport.selfAssessment.concerns ??
      []) {
      const id = await store.appendConcern({
        sourceIteration: iterationId,
        text: concern,
        confidence: result.generatorReport.selfAssessment.confidence,
      });
      appendedConcernIds.push(id);
    }
    for (const risk of result.plan.risks) {
      const id = await store.appendRisk({
        sourceIteration: iterationId,
        description: risk.description,
        severity: risk.severity,
      });
      appendedRiskIds.push(id);
    }
  }

  return {
    iterationId,
    result,
    appendedFindingIds,
    appendedConcernIds,
    appendedRiskIds,
  };
}

/**
 * Renders the iteration outcome as Markdown. Claude Code reads the
 * bash output of `monoceros-plugin iterate` and renders Markdown
 * directly in the chat, so headings, bullets, code spans and tables
 * all surface as proper formatted text.
 */
export function summarizeOutcome(outcome: IterateOutcome): string {
  return outcome.result.ok
    ? renderSuccess(outcome, outcome.result)
    : renderFailure(outcome, outcome.result);
}

function renderSuccess(
  outcome: IterateOutcome,
  result: Extract<IterationPipelineResult, { ok: true }>,
): string {
  const sections: string[] = [];
  const rec = result.reviewReport.recommendation;
  const icon = rec === 'approve' ? '✓' : rec === 'request_changes' ? '?' : '✗';

  // Headline
  sections.push(
    `## ${icon} Iteration ${shortId(outcome.iterationId)} — **${rec}**`,
  );

  // Phase metrics
  const m = result.metrics;
  const phaseLine = [
    `**Plan** ${fmtDuration(m.planner.durationMs)} · ${m.planner.numTurns} turns`,
    `**Generate** ${fmtDuration(m.generator.durationMs)} · ${m.generator.numTurns} turns`,
    `**Review** ${fmtDuration(m.reviewer.durationMs)} · ${m.reviewer.numTurns} turns`,
  ].join('  ·  ');
  const totalMs =
    m.planner.durationMs + m.generator.durationMs + m.reviewer.durationMs;
  const totalCost =
    m.planner.costUsd + m.generator.costUsd + m.reviewer.costUsd;
  sections.push(
    `${phaseLine}\n_Total: ${fmtDuration(totalMs)} · ${fmtCost(totalCost)}_`,
  );

  // Acceptance Criteria
  const acResults = result.reviewReport.acceptanceCriteriaResults;
  const totalACs = result.plan.acceptanceCriteria.length;
  if (totalACs > 0) {
    const metCount = acResults.filter((a) => a.status === 'met').length;
    const acLines: string[] = [
      `### Acceptance Criteria — ${metCount}/${totalACs} met`,
    ];
    for (const acResult of acResults) {
      const planAc = result.plan.acceptanceCriteria[acResult.acIndex];
      if (!planAc) continue;
      const acIcon =
        acResult.status === 'met'
          ? '✓'
          : acResult.status === 'unclear'
            ? '?'
            : '✗';
      acLines.push(`- ${acIcon} ${planAc.then}`);
    }
    sections.push(acLines.join('\n'));
  }

  // Files changed
  const changes = result.generatorReport.changesSummary;
  const totalChanges =
    changes.filesCreated.length +
    changes.filesModified.length +
    changes.filesDeleted.length;
  if (totalChanges > 0) {
    const lines = ['### Files changed'];
    if (changes.filesCreated.length > 0) {
      lines.push(`- **created** ${formatFileList(changes.filesCreated)}`);
    }
    if (changes.filesModified.length > 0) {
      lines.push(`- **modified** ${formatFileList(changes.filesModified)}`);
    }
    if (changes.filesDeleted.length > 0) {
      lines.push(`- **deleted** ${formatFileList(changes.filesDeleted)}`);
    }
    sections.push(lines.join('\n'));
  }

  // Tests
  const tr = result.generatorReport.testRun;
  if (tr.executed) {
    sections.push(
      `### Tests\n${tr.passed} passed${tr.failed > 0 ? ` · **${tr.failed} failed**` : ' · 0 failed'}`,
    );
  } else if (tr.outputExcerpt !== undefined && tr.outputExcerpt.length > 0) {
    sections.push(
      `### Tests\n_No test framework in project — verified via live probes._`,
    );
  }

  // Captured items
  const captureLines: string[] = [];
  if (outcome.appendedFindingIds.length > 0) {
    const sev = countBySeverity(
      result.reviewReport.findings.map((f) => f.severity),
    );
    captureLines.push(
      `- ${plural(outcome.appendedFindingIds.length, 'finding', 'findings')}${sev ? ` (${sev})` : ''}`,
    );
  }
  if (outcome.appendedConcernIds.length > 0) {
    captureLines.push(
      `- ${plural(outcome.appendedConcernIds.length, 'concern', 'concerns')}`,
    );
  }
  if (outcome.appendedRiskIds.length > 0) {
    const sev = countBySeverity(result.plan.risks.map((r) => r.severity));
    captureLines.push(
      `- ${plural(outcome.appendedRiskIds.length, 'risk', 'risks')}${sev ? ` (${sev})` : ''}`,
    );
  }
  if (captureLines.length > 0) {
    sections.push(
      `### Captured\n${captureLines.join('\n')}\n\n→ \`/findings\` to inspect, \`/triage <id> <status>\` to mark`,
    );
  }

  // Rewound notice
  if (result.rewound) {
    sections.push(
      `### Workspace rewound\nThe Generator's edits were rolled back because the Reviewer recommended \`reject\`. Your working tree is back to the state before this iteration started.`,
    );
  }

  // Reviewer summary
  if (result.reviewReport.summary) {
    sections.push(`### Reviewer\n${result.reviewReport.summary}`);
  }

  // Footer
  sections.push(
    `---\n_id: \`${outcome.iterationId}\` · audit: \`.monoceros/iterations/${outcome.iterationId}.json\`_`,
  );

  return sections.join('\n\n');
}

function renderFailure(
  outcome: IterateOutcome,
  result: Extract<IterationPipelineResult, { ok: false }>,
): string {
  const sections: string[] = [];
  const e = result.error;

  sections.push(
    `## ✗ Iteration ${shortId(outcome.iterationId)} — FAILED in **${result.failedPhase}**`,
  );

  // Error details by kind
  if (e.kind === 'sdk_error') {
    const lines: string[] = [`### Error: \`sdk_error\` / \`${e.subtype}\``];
    if (e.errors.length > 0) {
      for (const msg of e.errors) lines.push(`- ${msg}`);
    }
    sections.push(lines.join('\n'));
    if (e.stderrTail !== undefined && e.stderrTail.length > 0) {
      sections.push(`### Stderr tail\n\`\`\`\n${e.stderrTail}\n\`\`\``);
    }
  } else if (e.kind === 'missing_output') {
    sections.push(
      `### Error: \`missing_output\` / \`${e.reason}\`\nMessages seen on stream: ${
        e.messageTypes.length === 0
          ? '_(none)_'
          : e.messageTypes.map((t) => `\`${t}\``).join(', ')
      }`,
    );
    if (e.stderrTail !== undefined && e.stderrTail.length > 0) {
      sections.push(`### Stderr tail\n\`\`\`\n${e.stderrTail}\n\`\`\``);
    }
  } else if (e.kind === 'schema_validation') {
    const lines = ['### Error: `schema_validation`'];
    for (const issue of e.issues) {
      lines.push(`- \`${issue.path || '(root)'}\`: ${issue.message}`);
    }
    sections.push(lines.join('\n'));
  } else if (e.kind === 'aborted') {
    sections.push(`### Error: \`aborted\`\nThe iteration was cancelled.`);
  }

  // Partial outputs that did make it through
  const partial = result.partial;
  const partialLines: string[] = [];
  if (partial.plan !== undefined) {
    partialLines.push(
      `- ✓ Planner produced a plan (${partial.plan.acceptanceCriteria.length} ACs, ${partial.plan.risks.length} risks)`,
    );
  }
  if (partial.generatorReport !== undefined) {
    const changes = partial.generatorReport.changesSummary;
    partialLines.push(
      `- ✓ Generator report captured (${changes.filesCreated.length + changes.filesModified.length + changes.filesDeleted.length} file ops)`,
    );
  }
  if (partialLines.length > 0) {
    sections.push(`### Partial output\n${partialLines.join('\n')}`);
  }

  sections.push(
    `---\n_id: \`${outcome.iterationId}\` · audit: \`.monoceros/iterations/${outcome.iterationId}.json\`_`,
  );

  return sections.join('\n\n');
}

// ---- formatting helpers --------------------------------------------

function shortId(id: string): string {
  // 2026-05-12T07-39-14-594Z-zks791-iter → zks791
  const parts = id.split('-');
  if (parts.length >= 2 && parts[parts.length - 1] === 'iter') {
    return parts[parts.length - 2] ?? id;
  }
  return id;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const min = Math.floor(s / 60);
  const rs = Math.round(s - min * 60);
  return `${min}m ${rs}s`;
}

function fmtCost(usd: number): string {
  if (usd <= 0) return 'free';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function plural(n: number, singular: string, plurals: string): string {
  return `${n} ${n === 1 ? singular : plurals}`;
}

function countBySeverity(severities: readonly string[]): string {
  if (severities.length === 0) return '';
  const counts: Record<string, number> = {};
  for (const sev of severities) {
    counts[sev] = (counts[sev] ?? 0) + 1;
  }
  // Preserve a stable severity order: high → medium → low → info
  const order = ['high', 'medium', 'low', 'info'];
  const seen = new Set(Object.keys(counts));
  const ordered = [
    ...order.filter((s) => seen.has(s)),
    ...[...seen].filter((s) => !order.includes(s)),
  ];
  return ordered.map((sev) => `${counts[sev]} ${sev}`).join(', ');
}

function formatFileList(files: readonly string[]): string {
  return files.map((f) => `\`${f}\``).join(', ');
}

function buildAuditInput(
  input: IterationPipelineInput,
  result: IterationPipelineResult,
): Parameters<FindingsStore['appendIteration']>[0] {
  const base: Parameters<FindingsStore['appendIteration']>[0] = {
    userPrompt: input.userPrompt,
  };
  if (result.ok) {
    base.plan = result.plan;
    base.generatorReport = result.generatorReport;
    base.reviewReport = result.reviewReport;
    base.sessions = result.sessions;
    base.rewound = result.rewound;
    base.failedPhase = null;
  } else {
    base.failedPhase = result.failedPhase;
    base.errorSummary = formatErrorSummary(result.error);
    if (result.partial.plan !== undefined) base.plan = result.partial.plan;
    if (result.partial.generatorReport !== undefined) {
      base.generatorReport = result.partial.generatorReport;
    }
  }
  return base;
}

function formatErrorSummary(
  error: Extract<IterationPipelineResult, { ok: false }>['error'],
): string {
  switch (error.kind) {
    case 'sdk_error':
      return `sdk_error/${error.subtype}: ${error.errors.join('; ') || '(no error messages)'}${error.stderrTail ? `\nstderr tail: ${error.stderrTail}` : ''}`;
    case 'missing_output':
      return `missing_output/${error.reason}: messages seen = [${error.messageTypes.join(', ')}]${error.stderrTail ? `\nstderr tail: ${error.stderrTail}` : ''}`;
    case 'schema_validation':
      return `schema_validation: ${error.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`;
    case 'aborted':
      return 'aborted';
  }
}
