import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KydogError } from '../../shared/errors';
import type { ObservationSelection, SearchObservation, WebResearchTaskRecord,
  WebResearchTaskSource } from '../../shared/webResearchTask';
import { atomicWriteWith0600Async } from '../persist/atomicWrite';
import * as paths from '../persist/paths';
import { confirmSearchTarget, ENGINE_HOST } from './searchObservation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validId(id: string): void {
  if (!UUID.test(id)) throw new KydogError('research.not_found', 'Research task not found');
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** Source files are the index: a source update never rewrites a growing run.json. */
export class TaskStore {
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(private readonly configuredRoot?: string) {}
  private root(): string { return this.configuredRoot ?? paths.WEB_RESEARCH_DIR; }
  private threadDir(threadId: string): string { validId(threadId); return path.join(this.root(), threadId); }
  private taskDir(threadId: string, researchRunId: string): string {
    validId(researchRunId);
    return path.join(this.threadDir(threadId), researchRunId);
  }
  private sourceDir(threadId: string, researchRunId: string): string {
    return path.join(this.taskDir(threadId, researchRunId), 'task-sources');
  }
  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.writes.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.writes.set(key, current);
    const clear = () => { if (this.writes.get(key) === current) this.writes.delete(key); };
    void current.then(clear, clear);
    return current;
  }

  async saveObservation(observation: SearchObservation): Promise<void> {
    validId(observation.observationId);
    const dir = path.join(this.threadDir(observation.threadId), 'observations');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWriteWith0600Async(path.join(dir, `${observation.observationId}.json`), JSON.stringify(observation));
  }

  async loadObservation(threadId: string, observationId: string): Promise<SearchObservation> {
    validId(observationId);
    try {
      const file = path.join(this.threadDir(threadId), 'observations', `${observationId}.json`);
      const stored = JSON.parse(await fs.readFile(file, 'utf8')) as SearchObservation;
      const observation: SearchObservation = stored.executionFacts ? stored : {
        ...stored,
        executionPath: 'status_only',
        inputSubmitted: false,
        navigationConfirmed: false,
        resultsExtracted: false,
        executionFacts: {
          startUrl: stored.searchPageUrl,
          endUrl: stored.searchPageUrl,
          successfulWaits: [],
        },
      };
      if (observation.threadId !== threadId || observation.observationId !== observationId) throw new Error('observation mismatch');
      return observation;
    } catch (error) {
      if (missing(error)) throw new KydogError('research.not_found', 'Search observation not found');
      throw error;
    }
  }

  async confirmObservationTarget(threadId: string, observationId: string, resultIndex: number,
    requestedUrl: string, finalUrl: string): Promise<SearchObservation> {
    const file = path.join(this.threadDir(threadId), 'observations', `${observationId}.json`);
    let confirmed!: SearchObservation;
    await this.serial(`observations:${threadId}`, async () => {
      const observation = await this.loadObservation(threadId, observationId);
      if (observation.submittedToResearch) {
        throw new KydogError('research.observation_already_submitted',
          `Search observation already belongs to research run ${observation.submittedToResearch.researchRunId}`);
      }
      confirmed = confirmSearchTarget(observation, resultIndex, requestedUrl, finalUrl);
      await atomicWriteWith0600Async(file, JSON.stringify(confirmed));
    });
    return confirmed;
  }

  async lockObservationsForSubmit(threadId: string, researchRunId: string,
    selections: ObservationSelection[]): Promise<SearchObservation[]> {
    validId(researchRunId);
    return this.serial(`observations:${threadId}`, async () => {
      const seen = new Set<string>();
      for (const selection of selections) {
        validId(selection.observationId);
        if (seen.has(selection.observationId)) throw new Error('duplicate observation selection');
        seen.add(selection.observationId);
        if (selection.resultIndexes.some((index) =>
          !Number.isSafeInteger(index) || index < 0) ||
          new Set(selection.resultIndexes).size !== selection.resultIndexes.length) {
          throw new Error('invalid observation result indexes');
        }
      }
      const observations = await Promise.all(selections.map((selection) =>
        this.loadObservation(threadId, selection.observationId)));
      for (let i = 0; i < observations.length; i++) {
        const observation = observations[i];
        const selection = selections[i];
        if (!selection.resultIndexes.length && observation.rows.length) {
          throw new Error('empty observation selection requires a rowless observation');
        }
        if (selection.resultIndexes.some((index) => index >= observation.rows.length)) {
          throw new Error('observation result index out of range');
        }
        if (observation.submittedToResearch &&
          observation.submittedToResearch.researchRunId !== researchRunId) {
          throw new KydogError('research.observation_already_submitted',
            `Search observation already belongs to research run ${observation.submittedToResearch.researchRunId}`);
        }
      }
      const submittedAt = new Date().toISOString();
      const locked = observations.map((observation) => observation.submittedToResearch ? observation : ({
        ...observation, submittedToResearch: { researchRunId, submittedAt },
      }));
      await Promise.all(locked.map(async (observation) => {
        const file = path.join(this.threadDir(threadId), 'observations', `${observation.observationId}.json`);
        await atomicWriteWith0600Async(file, JSON.stringify(observation));
      }));
      return locked;
    });
  }

  async loadObservationTarget(threadId: string, observationId: string, resultIndex: number):
  Promise<{ requestedUrl: string; engineHost: string }> {
    const observation = await this.loadObservation(threadId, observationId);
    if (observation.submittedToResearch) {
      throw new KydogError('research.observation_already_submitted',
        `Search observation already belongs to research run ${observation.submittedToResearch.researchRunId}`);
    }
    const row = observation.rows[resultIndex];
    if (!row) throw new KydogError('research.not_found', 'Search result not found');
    let requestedUrl: string;
    try { requestedUrl = new URL(row.rawHref, observation.searchPageUrl).href; }
    catch { throw new KydogError('research.not_found', 'Search result URL is invalid'); }
    return { requestedUrl, engineHost: ENGINE_HOST[observation.engineId] };
  }

  async createTask(task: WebResearchTaskRecord): Promise<void> {
    await fs.mkdir(this.sourceDir(task.threadId, task.researchRunId), { recursive: true, mode: 0o700 });
    await this.saveTask(task);
  }

  async saveTask(task: WebResearchTaskRecord): Promise<void> {
    const file = path.join(this.taskDir(task.threadId, task.researchRunId), 'task.json');
    await this.serial(file, async () => {
      await atomicWriteWith0600Async(file, JSON.stringify(task));
    });
  }

  async loadTask(threadId: string, researchRunId: string): Promise<WebResearchTaskRecord> {
    try {
      const file = path.join(this.taskDir(threadId, researchRunId), 'task.json');
      const task = JSON.parse(await fs.readFile(file, 'utf8')) as WebResearchTaskRecord;
      if (task.threadId !== threadId || task.researchRunId !== researchRunId) throw new Error('task mismatch');
      return task;
    } catch (error) {
      if (missing(error)) throw new KydogError('research.not_found', 'Research task not found');
      throw error;
    }
  }

  async saveSource(task: WebResearchTaskRecord, source: WebResearchTaskSource): Promise<void> {
    validId(source.sourceId);
    if (source.passages.some((passage) => passage.sourceId !== source.sourceId)) throw new Error('passage source mismatch');
    const file = path.join(this.sourceDir(task.threadId, task.researchRunId), `${source.sourceId}.json`);
    await this.serial(file, () => atomicWriteWith0600Async(file, JSON.stringify(source)));
  }

  async loadSource(task: WebResearchTaskRecord, sourceId: string): Promise<WebResearchTaskSource> {
    validId(sourceId);
    try {
      const file = path.join(this.sourceDir(task.threadId, task.researchRunId), `${sourceId}.json`);
      const source = JSON.parse(await fs.readFile(file, 'utf8')) as WebResearchTaskSource;
      if (source.sourceId !== sourceId) throw new Error('source mismatch');
      return source;
    } catch (error) {
      if (missing(error)) throw new KydogError('research.not_found', 'Research source not found');
      throw error;
    }
  }

  async listSources(task: WebResearchTaskRecord): Promise<WebResearchTaskSource[]> {
    const dir = this.sourceDir(task.threadId, task.researchRunId);
    const names = await fs.readdir(dir).catch((error: unknown) => {
      if (missing(error)) return [] as string[];
      throw error;
    });
    const sources = await Promise.all(names.filter((name) => UUID.test(name.slice(0, -5)) && name.endsWith('.json'))
      .map((name) => this.loadSource(task, name.slice(0, -5))));
    return sources.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sourceId.localeCompare(b.sourceId));
  }

  async listTasks(threadId: string): Promise<WebResearchTaskRecord[]> {
    const names = await fs.readdir(this.threadDir(threadId)).catch((error: unknown) => {
      if (missing(error)) return [] as string[];
      throw error;
    });
    const tasks: WebResearchTaskRecord[] = [];
    for (const name of names.filter((candidate) => UUID.test(candidate))) {
      try { tasks.push(await this.loadTask(threadId, name)); }
      catch (error) { if (!(error instanceof KydogError && error.code === 'research.not_found')) throw error; }
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export const webResearchTaskStore = new TaskStore();
