/**
 * Storage interface for the Side-Topic-Memory described in
 * `docs/konzept.md`. The iteration pipeline produces three kinds of
 * curatable items — findings (from the Reviewer), concerns (from the
 * Generator's self-assessment) and risks (from the Planner) — plus
 * a per-iteration audit-trail entry that records what each phase
 * said and how the iteration ended.
 *
 * The local adapter (`@monoceros/adapter-local`) persists these as
 * Markdown files with YAML frontmatter under `.monoceros/` so the
 * Builder can edit them in any text editor and git tracks the
 * changes. Future M3 adapters (GitHub, Jira, Linear, Notion) will
 * implement the same interface and mirror the same items into
 * external systems.
 */

import type {
  GeneratorReport,
  IterationPlan,
  ReviewFinding,
  ReviewReport,
} from '../schemas/index.js';

export type FindingStatus = 'open' | 'jetzt' | 'später' | 'verworfen';
export type TriageStatus = Exclude<FindingStatus, 'open'>;

export type ItemKind = 'finding' | 'concern' | 'risk';

export interface FindingsStoreItem {
  /** Filename without extension — also the addressable id. */
  id: string;
  kind: ItemKind;
  /** Triage state — `'open'` until the Builder triages the item. */
  status: FindingStatus;
  /** id of the iteration audit-trail entry that produced this item. */
  sourceIteration: string;
  /** ISO timestamp of capture. */
  createdAt: string;
  /** YAML frontmatter, parsed. Caller-defined keys may live here. */
  frontmatter: Record<string, unknown>;
  /** Markdown body — the message / description text. */
  body: string;
}

export interface AppendFindingInput {
  sourceIteration: string;
  /** Mirrors the Reviewer's `ReviewFinding` shape. */
  finding: ReviewFinding;
}

export interface AppendConcernInput {
  sourceIteration: string;
  text: string;
  /** Confidence from the Generator's selfAssessment when known. */
  confidence?: 'high' | 'medium' | 'low';
}

export interface AppendRiskInput {
  sourceIteration: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
}

export interface AppendIterationInput {
  userPrompt: string;
  /**
   * Whichever of the three structured outputs the pipeline produced
   * before terminating. A failed iteration may carry a plan but no
   * generatorReport, etc.
   */
  plan?: IterationPlan;
  generatorReport?: GeneratorReport;
  reviewReport?: ReviewReport;
  sessions?: {
    planner?: string;
    generator?: string;
    reviewer?: string;
  };
  /** Whether the workspace was rewound after a `reject` recommendation. */
  rewound?: boolean;
  /** Phase that failed, if any. `null` for successful iterations. */
  failedPhase?: 'planner' | 'generator' | 'reviewer' | null;
  /** Human-readable error summary when `failedPhase` is set. */
  errorSummary?: string;
}

export interface FindingsStore {
  /** Adds an iteration to the audit trail. Returns the iteration id. */
  appendIteration(input: AppendIterationInput): Promise<string>;
  appendFinding(input: AppendFindingInput): Promise<string>;
  appendConcern(input: AppendConcernInput): Promise<string>;
  appendRisk(input: AppendRiskInput): Promise<string>;
  /** Lists items still in `open` status. */
  listOpen(): Promise<FindingsStoreItem[]>;
  /** Lists all items regardless of status. */
  listAll(): Promise<FindingsStoreItem[]>;
  /** Triages an item — moves it out of `open`. */
  markStatus(id: string, status: TriageStatus): Promise<void>;
  /** Reads a single item by id. Returns `null` if not found. */
  get(id: string): Promise<FindingsStoreItem | null>;
}
