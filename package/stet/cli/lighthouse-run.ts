/**
 * The one module that imports Lighthouse: the part of a result
 * `stet audit lighthouse` reads, and the runner over one headless Chrome.
 * Every other command never loads it.
 */

export type FormFactor = 'mobile' | 'desktop';

/** The part of a Lighthouse result the command reads. */
export interface LighthouseResult {
  lighthouseVersion: string;
  finalDisplayedUrl: string;
  /** Set where the page could not be loaded at all; every score is then null. */
  runtimeError?: { code: string; message: string };
  categories: Record<string, { score: number | null; auditRefs: Array<{ id: string; weight: number }> }>;
  audits: Record<
    string,
    {
      id: string;
      title: string;
      description: string;
      score: number | null;
      scoreDisplayMode: string;
      numericValue?: number;
      displayValue?: string;
      details?: { type: string; items?: Array<Record<string, unknown>> };
    }
  >;
}

/** One page measured once. Tests inject a fake; the command builds the real one. */
export type LighthouseRunner = (url: string, options: { formFactor: FormFactor; applied: boolean }) => Promise<LighthouseResult>;

export const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const;

/** Chrome was not found: what chrome-launcher throws, told apart from any other failure. */
export class ChromeMissing extends Error {}

/** An audit package that does not load: a broken or pruned install, told apart from any other failure. */
export class AuditPackageMissing extends Error {}

/** One of the audit's packages imported, a missing one raised as `AuditPackageMissing`. */
export async function importAuditPackage<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') throw new AuditPackageMissing();
    throw error;
  }
}

/**
 * The real runner over one Chrome, started headless and ended by `close`.
 * `insecure` starts it with `--ignore-certificate-errors`, for the front's
 * run-scoped certificate (`cli/audit-target.ts`).
 */
export async function chromeRunner(insecure: boolean): Promise<{ run: LighthouseRunner; close: () => Promise<void> }> {
  const { default: lighthouse, desktopConfig } = await importAuditPackage(() => import('lighthouse'));
  const { launch } = await importAuditPackage(() => import('chrome-launcher'));
  let chrome: Awaited<ReturnType<typeof launch>>;
  try {
    // chrome-launcher's own SIGINT handler calls `process.exit(130)` before any `finally` runs; the command's listener does the cleanup.
    chrome = await launch({ handleSIGINT: false, chromeFlags: ['--headless=new', ...(insecure ? ['--ignore-certificate-errors'] : [])] });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_LAUNCHER_NOT_INSTALLED') throw new ChromeMissing();
    throw error;
  }
  const run: LighthouseRunner = async (url, options) => {
    const result = await lighthouse(
      url,
      {
        port: chrome.port,
        output: 'json',
        logLevel: 'silent',
        // The four categories alone: the agentic-browsing gatherers never run.
        onlyCategories: [...CATEGORIES],
        ...(options.applied ? { throttlingMethod: 'devtools' as const } : {}),
      },
      options.formFactor === 'desktop' ? desktopConfig : undefined,
    );
    if (result === undefined) throw new Error(`Lighthouse returned no result for ${url}`);
    return result.lhr as unknown as LighthouseResult;
  };
  return { run, close: async () => chrome.kill() };
}
