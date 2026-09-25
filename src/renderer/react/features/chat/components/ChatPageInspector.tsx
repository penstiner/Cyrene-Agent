import { useTranslation } from "../../../i18n";
import { PlanContent, planTabDotClass, planTabLabel, type PlanReviewPhase } from "./PlanReviewPanel";
import { ReviewDiffContent } from "./ReviewInspector";
import { RightInspector, type InspectorTab } from "./RightInspector";

export type ChatPageInspectorTabId = "diff" | "plan";

export interface ChatPageInspectorProps {
  reviewInspector: { runId: string; fileIndex: number } | null;
  activePlan: { content: string; phase: PlanReviewPhase } | null;
  planDrawerOpen: boolean;
  activeTabId: ChatPageInspectorTabId;
  onTabChange: (id: ChatPageInspectorTabId) => void;
  onCloseTab: (id: ChatPageInspectorTabId) => void;
  /** 在面板内切换 diff 文件（chips 导航），同步回 ChatPage 的 reviewInspector.fileIndex */
  onFileSelect?: (fileIndex: number) => void;
}

export function ChatPageInspector({
  reviewInspector,
  activePlan,
  planDrawerOpen,
  activeTabId,
  onTabChange,
  onCloseTab,
  onFileSelect,
}: ChatPageInspectorProps) {
  const { t } = useTranslation();
  const tabs: InspectorTab[] = [];
  if (reviewInspector) {
    tabs.push({
      id: "diff",
      label: t("review.inspectorDiffTab"),
      content: (
        <ReviewDiffContent
          runId={reviewInspector.runId}
          fileIndex={reviewInspector.fileIndex}
          onFileSelect={onFileSelect}
        />
      ),
    });
  }
  if (activePlan && planDrawerOpen) {
    tabs.push({
      id: "plan",
      label: planTabLabel(activePlan.phase),
      dotClass: planTabDotClass(activePlan.phase),
      content: <PlanContent content={activePlan.content} phase={activePlan.phase} />,
    });
  }
  if (tabs.length === 0) return null;

  return (
    <RightInspector
      tabs={tabs}
      activeTabId={activeTabId}
      onTabChange={(id) => onTabChange(id as ChatPageInspectorTabId)}
      onClose={() => onCloseTab(activeTabId)}
    />
  );
}
