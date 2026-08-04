import type { UpdateStatus, UpdateAvailability, UpdateCheckPhase } from '../../shared/types';
import type { CheckEngine, CheckOutcome } from './engine';

export interface UpdateServiceDeps {
  engine: CheckEngine;
  currentVersion: string;
  deadlineMs: number;
  initialAutoCheck: boolean;
  initialDismissedCandidateId: string | null;
  persistAutoCheck(enabled: boolean): Promise<void>;
  persistDismissed(candidateId: string): Promise<void>;
  onStatusChange(status: UpdateStatus): void;
}

export class UpdateService {
  private check_: UpdateCheckPhase = { phase: 'never' };
  private update_: UpdateAvailability = { kind: 'none' };
  private autoCheck_: boolean;
  private dismissedCandidateId: string | null;
  /** downloaded 之后的会话级忽略。协议只给了 releaseName，没有可靠身份可落盘，
   *  而这个状态本就活不过进程 —— 重启后应用已是新版。 */
  private sessionDismissed = false;
  /** Windows deadline 到达后置位：本进程不再检查，直到迟到的终态事件解除它。 */
  private disabledUntilRestart = false;

  constructor(private deps: UpdateServiceDeps) {
    this.autoCheck_ = deps.initialAutoCheck;
    this.dismissedCandidateId = deps.initialDismissedCandidateId;
    deps.engine.onLateOutcome((o) => this.applyLateOutcome(o));
  }

  getStatus(): UpdateStatus {
    return {
      check: this.check_,
      update: this.update_,
      bannerDismissed: this.computeBannerDismissed(),
      autoCheck: this.autoCheck_,
      currentVersion: this.deps.currentVersion,
    };
  }

  /** 忽略策略的平台差异在这里被吸收成一个布尔，渲染进程看不到。 */
  private computeBannerDismissed(): boolean {
    if (this.update_.kind === 'none') return false;
    if (this.update_.kind === 'downloaded') return this.sessionDismissed;
    return this.dismissedCandidateId !== null && this.dismissedCandidateId === this.update_.candidateId;
  }

  private emit(): void { this.deps.onStatusChange(this.getStatus()); }

  /** 把一次检查结果并入状态。两条不变量在此集中兑现：
   *  失败只写 check；downloaded 不可降级。 */
  private applyOutcome(o: CheckOutcome): void {
    if (o.kind === 'failed') {
      this.check_ = { phase: 'failed', message: o.message, retry: o.retry };
      if (o.retry === 'restart-required') this.disabledUntilRestart = true;
      this.emit();
      return;
    }
    this.check_ = { phase: 'ok' };
    if (this.update_.kind === 'downloaded') { this.emit(); return; } // 不可降级
    if (o.kind === 'none') this.update_ = { kind: 'none' };
    else if (o.kind === 'available') this.update_ = { kind: 'available', candidateId: o.candidateId, label: o.label };
    else this.update_ = { kind: 'downloaded', label: o.label };
    this.emit();
  }

  /** deadline 之后到达的终态事件。它证明旧检查已经结束，于是解除禁用 ——
   *  否则对外显示「已是最新」而内部仍拒绝检查，协议与内部状态就漂移了。 */
  private applyLateOutcome(o: CheckOutcome): void {
    this.disabledUntilRestart = false;
    this.applyOutcome(o);
  }

  async check(): Promise<UpdateStatus> {
    if (this.update_.kind === 'downloaded') return this.getStatus(); // 进程终态
    if (this.disabledUntilRestart) return this.getStatus();
    this.check_ = { phase: 'checking' };
    this.emit();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.deps.deadlineMs);
    try {
      const o = await this.deps.engine.run(ac.signal);
      this.applyOutcome(o);
    } finally {
      clearTimeout(timer);
    }
    return this.getStatus();
  }
}
