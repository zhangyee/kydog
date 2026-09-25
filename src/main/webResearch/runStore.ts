import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KydogError } from '../../shared/errors';
import type { Discovery, Passage, ResearchAngle, ResearchBudget, ResearchUsage,
  SearchAttempt, SearchEngineId, SourceExtraction } from '../../shared/webResearch';
import { atomicWriteWith0600Async } from '../persist/atomicWrite';
import * as paths from '../persist/paths';

export type SourceStatus = 'queued' | 'fetching' | 'extracting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type SourceIndex = {
  sourceId: string;
  requestedUrl: string;
  finalUrl?: string;
  contentHash?: string;
  completeness?: 'complete' | 'truncated' | 'unknown';
  status: SourceStatus;
  reason?: string;
  discoveries: Discovery[];
  receivedBytes?: number;
  evidenceIds?: string[];
  /** Another requested URL resolved to this source's exact final URL and body hash. */
  aliasOf?: string;
};
export type SavedSource = SourceIndex & {
  passages: Passage[];
  extraction?: SourceExtraction;
};
export type ResearchRunRecord = {
  researchRunId: string;
  threadId: string;
  originalQuestion: string;
  createdAt: string;
  updatedAt: string;
  angles: ResearchAngle[];
  enabledEngines: SearchEngineId[];
  attempts: SearchAttempt[];
  candidates: Array<{ requestedUrl: string; discoveries: Discovery[] }>;
  budget: ResearchBudget;
  usage: ResearchUsage;
  sources: SourceIndex[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validId(id: string): void {
  if (!UUID.test(id)) throw new KydogError('research.not_found', 'Research run not found');
}
function notFound(): KydogError { return new KydogError('research.not_found', 'Research run not found'); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

export class RunStore {
  private readonly active = new Set<string>();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly configuredRoot?: string) {}
  private root(): string { return this.configuredRoot ?? paths.WEB_RESEARCH_DIR; }
  private threadDir(threadId: string): string { validId(threadId); return path.join(this.root(), threadId); }
  private runDir(threadId: string, researchRunId: string): string {
    validId(researchRunId);
    return path.join(this.threadDir(threadId), researchRunId);
  }
  private sourcePath(run: ResearchRunRecord, sourceId: string): string {
    validId(sourceId);
    return path.join(this.runDir(run.threadId, run.researchRunId), 'sources', `${sourceId}.json`);
  }
  private enqueue(run: ResearchRunRecord, operation: () => Promise<void>): Promise<void> {
    const key = `${run.threadId}/${run.researchRunId}`;
    const previous = this.writes.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.writes.set(key, current);
    void current.then(() => { if (this.writes.get(key) === current) this.writes.delete(key); },
      () => { if (this.writes.get(key) === current) this.writes.delete(key); });
    return current;
  }
  private async writeRunFile(run: ResearchRunRecord): Promise<void> {
    const file = path.join(this.runDir(run.threadId, run.researchRunId), 'run.json');
    run.updatedAt = new Date().toISOString();
    await atomicWriteWith0600Async(file, JSON.stringify(run));
  }

  async createRun(run: ResearchRunRecord): Promise<void> {
    const dir = this.runDir(run.threadId, run.researchRunId);
    await fs.mkdir(path.join(dir, 'sources'), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.chmod(this.root(), 0o700);
      await fs.chmod(this.threadDir(run.threadId), 0o700);
      await fs.chmod(dir, 0o700);
      await fs.chmod(path.join(dir, 'sources'), 0o700);
    }
    await this.saveRun(run);
    this.active.add(run.researchRunId);
  }

  async saveRun(run: ResearchRunRecord): Promise<void> {
    await this.enqueue(run, () => this.writeRunFile(run));
  }

  async saveSource(run: ResearchRunRecord, source: SavedSource): Promise<void> {
    if (source.passages.some((passage) => passage.sourceId !== source.sourceId)) throw new Error('passage source mismatch');
    await this.enqueue(run, async () => {
      const file = this.sourcePath(run, source.sourceId);
      await atomicWriteWith0600Async(file, JSON.stringify(source));
      const { passages: _passages, extraction: _extraction, ...index } = source;
      const saved: SourceIndex = { ...index, evidenceIds: source.extraction?.evidence.map((item) => item.evidenceId) };
      const position = run.sources.findIndex((item) => item.sourceId === source.sourceId);
      if (position >= 0) run.sources[position] = saved;
      else run.sources.push(saved);
      await this.writeRunFile(run);
    });
  }

  async loadSource(run: ResearchRunRecord, sourceId: string): Promise<SavedSource> {
    if (!run.sources.some((source) => source.sourceId === sourceId)) throw notFound();
    try { return JSON.parse(await fs.readFile(this.sourcePath(run, sourceId), 'utf8')) as SavedSource; }
    catch (error) { if (isMissing(error)) throw notFound(); throw error; }
  }

  async loadRun(threadId: string, researchRunId: string): Promise<ResearchRunRecord> {
    const dir = this.runDir(threadId, researchRunId);
    let run: ResearchRunRecord;
    try { run = JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8')) as ResearchRunRecord; }
    catch (error) { if (isMissing(error)) throw notFound(); throw error; }
    if (run.threadId !== threadId || run.researchRunId !== researchRunId || !Array.isArray(run.sources)) throw notFound();
    if (this.active.has(researchRunId)) return run;
    let changed = false;
    const indexed = new Set<string>();
    for (const source of run.sources) {
      validId(source.sourceId);
      indexed.add(`${source.sourceId}.json`);
      if (source.status === 'queued' || source.status === 'fetching' || source.status === 'extracting') {
        source.status = 'interrupted'; changed = true;
      }
      if (source.status === 'completed' && !source.aliasOf) {
        try { await fs.access(this.sourcePath(run, source.sourceId)); }
        catch { source.status = 'interrupted'; source.reason = 'missing_source_file'; changed = true; }
      }
    }
    const sourceDir = path.join(dir, 'sources');
    let files: string[] = [];
    try { files = await fs.readdir(sourceDir); } catch (error) { if (!isMissing(error)) throw error; }
    for (const file of files) {
      if (!indexed.has(file)) await fs.rm(path.join(sourceDir, file), { force: true, recursive: true });
    }
    if (changed) await this.saveRun(run);
    return run;
  }

  async listRuns(threadId: string): Promise<ResearchRunRecord[]> {
    const dir = this.threadDir(threadId);
    let names: string[];
    try { names = await fs.readdir(dir); } catch (error) { if (isMissing(error)) return []; throw error; }
    const runs: ResearchRunRecord[] = [];
    for (const name of names) {
      if (!UUID.test(name)) continue;
      try { runs.push(await this.loadRun(threadId, name)); }
      catch (error) { if (!isMissing(error) && !(error instanceof KydogError && error.code === 'research.not_found')) throw error; }
    }
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  closeRun(researchRunId: string): void { this.active.delete(researchRunId); }
  activateRun(researchRunId: string): void { validId(researchRunId); this.active.add(researchRunId); }

  async removeRunsForThread(threadId: string): Promise<void> {
    await fs.rm(this.threadDir(threadId), { recursive: true, force: true });
  }
}

export const researchRunStore = new RunStore();
