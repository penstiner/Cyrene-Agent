// ReviewDiffContent — Review diff 内容（由 RightInspector 容器承载）。
//
// 职责：文件 chips 导航 + 被选中文件的 inline diff 视图 + 文件名标题条。
// 文件列表同时存在于气泡内的 ReviewPanel；两侧选中文件通过 ChatPage 的
// reviewInspector 状态互相同步（点 chips / 点气泡文件行都更新同一状态）。
// 外层 aside / tab 栏 / 关闭按钮由 RightInspector 统一提供。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n";
import { CopyButton } from "./CopyButton";
import { splitPath } from "./ReviewPanel";
import type { ReviewFileChange, ReviewLine, ReviewSnapshot } from "../../../../../shared/review-types";
import "./ReviewInspector.css";

// 只存 i18n key（t() 不能出现在模块顶层常量里），展示文案在组件内求值。
const KIND_LABEL_KEYS: Record<ReviewFileChange["kind"], string> = {
  modified: "review.kindModified",
  created: "review.kindCreated",
  deleted: "review.kindDeleted",
  renamed: "review.kindRenamed",
  binary: "review.kindBinary",
  "large-text": "review.kindLargeText",
};

const KIND_CLASS: Record<ReviewFileChange["kind"], string> = {
  modified: "is-modified",
  created: "is-created",
  deleted: "is-deleted",
  renamed: "is-renamed",
  binary: "is-binary",
  "large-text": "is-large",
};

/** 把结构化 hunk 拼回 unified diff 文本，供复制。 */
function buildPatchText(file: ReviewFileChange): string {
  const lines: string[] = [
    `--- ${file.oldPath || file.newPath}`,
    `+++ ${file.newPath}`,
  ];
  for (const hunk of file.hunks ?? []) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
      lines.push(`${marker}${line.text}`);
    }
  }
  return lines.join("\n");
}

export function ReviewDiffContent({
  runId,
  fileIndex,
  onFileSelect,
}: {
  runId: string;
  fileIndex: number;
  onFileSelect?: (fileIndex: number) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  // 与气泡内 ReviewPanel 相同的重试策略（3 × 500ms）：run 结束与快照落盘之间可能有延迟；
  // 重试耗尽后展示「不可用」而不是永远停在加载中
  useEffect(() => {
    let cancelled = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 500;
    setLoading(true);
    const fetchData = async () => {
      if (cancelled) return;
      try {
        const result = await window.review?.get(runId);
        if (cancelled) return;
        if (result && result.files.length > 0) {
          setSnapshot(result);
          setLoading(false);
          return;
        }
      } catch {
        // 忽略，进入重试
      }
      retryCount += 1;
      if (retryCount < MAX_RETRIES && !cancelled) {
        window.setTimeout(() => void fetchData(), RETRY_DELAY);
        return;
      }
      if (!cancelled) setLoading(false);
    };
    void fetchData();
    return () => { cancelled = true; };
  }, [runId, reloadToken]);

  const files = snapshot?.files ?? [];
  const file = files[fileIndex];

  const refresh = useCallback(() => {
    setSnapshot(null);
    setReloadToken((token) => token + 1);
  }, []);

  const patchText = useMemo(() => (file ? buildPatchText(file) : ""), [file]);

  return (
    <div className="cy-review-diff-content">
      <div className="cy-review-inspector__file-title" title={file?.newPath ?? ""}>
        {file && (
          <span className={`cy-review-inspector__kind ${KIND_CLASS[file.kind]}`}>
            {t(KIND_LABEL_KEYS[file.kind])}
          </span>
        )}
        <span className="cy-review-inspector__title-text">
          {file?.newPath ?? (loading ? t("common.loading") : t("review.unavailable"))}
        </span>
        <span className="cy-review-inspector__title-actions">
          {file && <CopyButton text={patchText} size={14} />}
          <button type="button" className="cy-review-inspector__refresh" onClick={refresh} aria-label={t("review.refreshDiff")}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 1.5v3h-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
            </svg>
          </button>
        </span>
      </div>
      {files.length > 1 && (
        <div className="cy-review-inspector__file-chips" aria-label={t("review.fileListAria")}>
          {files.map((chipFile, index) => {
            const { base } = splitPath(chipFile.newPath);
            const active = index === fileIndex;
            return (
              <button
                key={`${chipFile.kind}:${chipFile.newPath}:${index}`}
                type="button"
                aria-current={active ? "true" : undefined}
                className={`cy-review-inspector__chip${active ? " is-active" : ""}`}
                onClick={() => onFileSelect?.(index)}
                title={chipFile.newPath}
              >
                <span className={`cy-review-inspector__chip-dot ${KIND_CLASS[chipFile.kind]}`} aria-hidden="true" />
                <span className="cy-review-inspector__chip-base">{base}</span>
                <span className="cy-review-inspector__chip-stats">
                  {chipFile.additions > 0 && <span className="is-add">+{chipFile.additions}</span>}
                  {chipFile.deletions > 0 && <span className="is-remove">−{chipFile.deletions}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="cy-review-inspector__body">
        {!file && (
          <div className="cy-review-inspector__loading">
            {loading ? t("common.loading") : t("review.unavailable")}
          </div>
        )}
        {file && <DiffView file={file} />}
      </div>
    </div>
  );
}

function DiffView({ file }: { file: ReviewFileChange }) {
  const { t } = useTranslation();
  if (file.kind === "binary" || file.kind === "large-text") {
    return (
      <div className="cy-review-inspector__meta">
        <div className="cy-review-inspector__meta-info">
          <span className={`cy-review-inspector__kind ${KIND_CLASS[file.kind]}`}>{t(KIND_LABEL_KEYS[file.kind])}</span>
          {file.before && (
            <span className="cy-review-inspector__meta-size">
              {formatSize(file.before.size)}
              {file.after ? ` → ${formatSize(file.after.size)}` : ""}
            </span>
          )}
          {!file.before && file.after && (
            <span className="cy-review-inspector__meta-size">{formatSize(file.after.size)}</span>
          )}
        </div>
        <div className="cy-review-inspector__meta-hint">
          {file.kind === "binary" ? t("review.binaryHint") : t("review.largeTextHint")}
        </div>
      </div>
    );
  }

  if (!file.hunks || file.hunks.length === 0) {
    return (
      <div className="cy-review-inspector__meta">
        <div className="cy-review-inspector__meta-hint">
          {file.kind === "renamed" ? t("review.renamedHint") : t("review.noDiffHint")}
        </div>
      </div>
    );
  }

  return (
    <div className="cy-review-inspector__diff-content">
      <div className="cy-review-inspector__diff-lines">
        {file.hunks.map((hunk, hunkIndex) => (
          <div key={hunkIndex} className="cy-review-inspector__hunk">
            <div className="cy-review-inspector__hunk-header">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, lineIndex) => (
              <DiffLine key={lineIndex} line={line} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffLine({ line }: { line: ReviewLine }) {
  const lineClass = line.type === "add" ? "is-add" : line.type === "remove" ? "is-remove" : "is-context";
  const marker = line.type === "add" ? "+" : line.type === "remove" ? "−" : " ";
  return (
    <div className={`cy-review-inspector__line ${lineClass}`}>
      <span className="cy-review-inspector__line-old">{line.oldLine ?? ""}</span>
      <span className="cy-review-inspector__line-new">{line.newLine ?? ""}</span>
      <span className="cy-review-inspector__line-marker" aria-hidden="true">{marker}</span>
      <span className="cy-review-inspector__line-text">{line.text || " "}</span>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
