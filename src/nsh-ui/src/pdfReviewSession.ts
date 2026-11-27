import { signal } from "nsh";
import { readFileContent } from "./api";
import { invokeCommand } from "./bridge";
import type { WorkspaceKey } from "./fleetTypes";
import { contentHash } from "./fileStore";
import { emptyPdfReview, parsePdfReview, pdfReviewSidecar, type PdfReviewAnnotation, type PdfReviewData } from "./pdfReviewData";
import { isWorkspaceFileMissing } from "./workspaceBinaryFile";

interface ReviewDisk {
  text?: string;
  hash: string;
}

interface PdfReviewSnapshot {
  data: PdfReviewData;
  loaded: boolean;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  conflictReadable: boolean;
  error?: string;
  canUndo: boolean;
  canRedo: boolean;
}

async function checkedHash(text: string): Promise<string> {
  const hash = await contentHash(text);
  if (!hash) throw new Error("The review file hash is unavailable");
  return hash;
}

/** A tab owns this session, including when its preview is temporarily hidden. */
export class PdfReviewSession {
  /** A known copy version can be replaced without a fresh overwrite prompt. */
  exportedHash?: string;
  readonly commentDraft = signal<{ id: string; value: string; commentId?: string } | null>(null);
  readonly hasPending = () => this.snapshot().dirty || Boolean(this.commentDraft()?.value.trim());
  readonly snapshot = signal<PdfReviewSnapshot>({
    data: emptyPdfReview(), loaded: false, readOnly: false, dirty: false, saving: false,
    conflict: false, conflictReadable: false, canUndo: false, canRedo: false,
  });
  private readonly sidecar: string;
  private readonly route;
  private hash = "";
  private revision = 0;
  private attempt?: string;
  private conflictDisk?: ReviewDisk;
  private reading?: Promise<void>;
  private writing?: Promise<void>;
  private past: PdfReviewData[] = [];
  private future: PdfReviewData[] = [];
  private embedded?: PdfReviewData;

  constructor(private readonly workspace: WorkspaceKey, path: string) {
    this.sidecar = pdfReviewSidecar(path);
    this.route = workspace.deviceId ? { target: workspace.deviceId } : undefined;
  }

  private publish(patch: Partial<PdfReviewSnapshot>) {
    this.snapshot.update(current => ({
      ...current, ...patch, canUndo: this.past.length > 0, canRedo: this.future.length > 0,
    }));
  }

  private async readDisk(): Promise<ReviewDisk> {
    let text: string;
    try {
      text = await readFileContent(this.workspace.workspaceId, this.sidecar, undefined, this.route);
    } catch (error) {
      if (isWorkspaceFileMissing(error)) return { hash: "" };
      throw error;
    }
    if (typeof text !== "string") throw new Error("The workspace returned an invalid review file");
    return { text, hash: await checkedHash(text) };
  }

  load(): Promise<void> {
    if (this.snapshot().loaded) return Promise.resolve();
    return this.reading ??= this.loadDisk().finally(() => { this.reading = undefined; });
  }

  private async loadDisk() {
    try {
      const disk = await this.readDisk();
      const data = disk.text === undefined ? this.embedded ?? emptyPdfReview() : parsePdfReview(disk.text);
      this.hash = disk.hash;
      this.publish({ data, loaded: true, readOnly: false, error: undefined });
    } catch (error) {
      this.publish({ loaded: true, readOnly: true, error: String(error), ...(this.embedded ? { data: this.embedded } : {}) });
    }
  }

  retry() {
    if (!this.snapshot().readOnly) return this.save();
    this.publish({ loaded: false, error: undefined });
    return this.load();
  }

  importEmbedded(data: PdfReviewData) {
    if (this.embedded) return;
    this.embedded = data;
    if (this.snapshot().loaded && !this.hash && !this.snapshot().dirty && !this.snapshot().data.annotations.length) {
      this.publish({ data });
    }
  }

  private editable() {
    const state = this.snapshot();
    return state.loaded && !state.readOnly && !state.conflict;
  }

  private remember(data = this.snapshot().data) {
    this.past.push(data);
    if (this.past.length > 64) this.past.shift();
    this.future = [];
  }

  private apply(data: PdfReviewData) {
    this.revision++;
    this.publish({ data, dirty: true, error: undefined });
    void this.save();
  }

  replace(annotations: PdfReviewAnnotation[], fingerprint: string) {
    if (!this.editable()) return false;
    this.remember();
    const data = this.snapshot().data;
    this.apply({ ...data, fingerprint: data.fingerprint || fingerprint, annotations });
    return true;
  }

  confirmLayout(fingerprint: string) {
    if (!this.editable() || !fingerprint || fingerprint === this.snapshot().data.fingerprint) return;
    this.remember();
    this.apply({ ...this.snapshot().data, fingerprint });
  }

  private withDraft(): PdfReviewData | null {
    const draft = this.commentDraft();
    const body = draft?.value.trim();
    const data = this.snapshot().data;
    if (!draft || !body || !data.annotations.some(annotation => annotation.id === draft.id &&
        (!draft.commentId || annotation.comments.some(comment => comment.id === draft.commentId)))) return null;
    const comment = { id: pdfReviewId(), body, createdAt: new Date().toISOString() };
    return { ...data, annotations: data.annotations.map(annotation => annotation.id === draft.id ?
      { ...annotation, comments: draft.commentId
        ? annotation.comments.map(item => item.id === draft.commentId ? { ...item, body } : item)
        : [...annotation.comments, comment] } : annotation) };
  }

  commitDraft(): boolean {
    if (!this.commentDraft()?.value.trim()) return true;
    const data = this.withDraft();
    if (!data) return false;
    const changed = this.replace(data.annotations, data.fingerprint);
    if (changed) this.commentDraft.set(null);
    return changed;
  }

  undo() {
    if (!this.editable()) return;
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.snapshot().data);
    this.apply(previous);
  }

  redo() {
    if (!this.editable()) return;
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snapshot().data);
    this.apply(next);
  }

  save(): Promise<void> {
    if (this.writing) return this.writing;
    if (!this.editable() || !this.snapshot().dirty) return Promise.resolve();
    return this.writing = this.write().finally(() => {
      this.writing = undefined;
      this.publish({ saving: false });
    });
  }

  private async write() {
    this.publish({ saving: true, error: undefined });
    try {
      // A transport failure can arrive after a successful write.
      if (this.attempt !== undefined) {
        const disk = await this.readDisk();
        if (disk.text === this.attempt) {
          this.hash = disk.hash;
          if (disk.text === JSON.stringify(this.snapshot().data, null, 2) + "\n") this.publish({ dirty: false });
        }
        else if (disk.hash !== this.hash) {
          this.recordConflict(disk);
          return;
        }
        this.attempt = undefined;
      }
      while (this.snapshot().dirty) {
        const revision = this.revision;
        const content = JSON.stringify(this.snapshot().data, null, 2) + "\n";
        const writtenHash = await checkedHash(content);
        this.attempt = content;
        await invokeCommand("write_file_content", {
          workspaceId: this.workspace.workspaceId, filePath: this.sidecar, content, expectedHash: this.hash,
        }, this.route);
        this.hash = writtenHash;
        this.attempt = undefined;
        this.publish({ dirty: this.revision !== revision });
      }
    } catch (error) {
      if (String(error).includes("FILE_CONFLICT")) {
        this.attempt = undefined;
        this.recordConflict(await this.readDisk().catch(() => undefined));
      } else {
        this.publish({ error: String(error) });
      }
    }
  }

  private recordConflict(disk?: ReviewDisk) {
    this.conflictDisk = disk;
    this.publish({ conflict: true, conflictReadable: disk !== undefined, error: undefined });
  }

  async keepLocal() {
    if (!this.snapshot().conflict || !this.conflictDisk || this.writing) return;
    this.hash = this.conflictDisk.hash;
    this.attempt = undefined;
    this.conflictDisk = undefined;
    this.publish({ conflict: false, conflictReadable: false });
    this.commitDraft();
    await this.save();
  }

  async reloadHost() {
    if (!this.snapshot().conflict || this.writing) return;
    try {
      const disk = await this.readDisk();
      const data = disk.text === undefined ? emptyPdfReview() : parsePdfReview(disk.text);
      this.remember(this.withDraft() ?? this.snapshot().data);
      this.commentDraft.set(null);
      this.hash = disk.hash;
      this.attempt = undefined;
      this.conflictDisk = undefined;
      this.publish({ data, dirty: false, conflict: false, conflictReadable: false, error: undefined });
    } catch (error) {
      this.publish({ error: String(error) });
    }
  }
}

export function pdfReviewId(): string {
  return globalThis.crypto?.randomUUID?.() ?? "review-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
