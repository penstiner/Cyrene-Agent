import { Bubble, CodeHighlighter, Think, ThoughtChain, type BubbleItemType } from "@ant-design/x";
import { XMarkdown, type ComponentProps } from "@ant-design/x-markdown";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import { Image as AntImage } from "antd";
// mhchem 化学方程式扩展：依赖包内的 katex 与 x-markdown Latex 插件解析到同一实例（npm 去重后同源）
import "katex/contrib/mhchem";
import { Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type KeyboardEvent, type ReactNode } from "react";
import { t, useTranslation } from "../../../i18n";
import { normalizeModelMarkdown } from "./markdown-normalize";
import { resolveAsset } from "../../../../../shared/renderer-base";
import type { AgentRoundRecord, ChatMessageChannelSource, ConversationMode, ProcessMessageRecord, ReasoningBlock, RunActivityRecord, TaskDelegationDisplayRecord, ToolExecutionRecord, ToolFileChange } from "../../../../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import thinkingMoodUrl from "../../../assets/status-moods/思考中.png?url";
import completedThinkingMoodUrl from "../../../assets/status-moods/提醒.png?url";
import workingMoodUrl from "../../../assets/status-moods/工作中.png?url";
import interruptedMoodUrl from "../../../assets/status-moods/已中断.png?url";
import processedMoodUrl from "../../../assets/status-moods/已处理.png?url";
import connectingMoodUrl from "../../../assets/status-moods/连接中.png?url";
import { useUserAvatar } from "../../../hooks/useUserAvatar";
import {
  assistantRenderStages,
  resolveReasoningExpanded,
  updateReasoningExpanded,
} from "./message-visibility";
import { formatElapsed, resolveRunActivityExpanded, resolveRunActivitySnapshot, shouldAutoCollapseRunActivity } from "./run-activity";
import { RunStageIndicator } from "./RunStageIndicator";
import { TaskPlanCard } from "./TaskPlanCard";
import type { AgentRunStage, TaskPlanPresentation } from "./run-presentation";
import { CopyButton } from "./CopyButton";
import { TtsButton } from "./TtsButton";
import { stopTtsPlayback } from "./tts-playback";
import { LastTurnActionButton } from "./LastTurnActionButton";
import { resolveRevisableLastTurn, type RevisableLastTurn } from "./last-turn-actions";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";
import type { WeatherData } from "./weather/weather-types";
import { WeatherCard } from "./weather/WeatherCard";
import { countRoundChangedFiles, describeToolExecution, resolveAgentRoundTitle } from "./agent-rounds";
import { TaskDelegationRow } from "./TaskDelegationRow";
import { extractFileChanges, FileChangeCard } from "./FileChangeCard";
import { ReviewPanel } from "./ReviewPanel";
import { MermaidBlock } from "./MermaidBlock";
import { SvgCardBlock } from "./SvgCardBlock";
import { formatDayDivider, formatMessageClock } from "./message-time";

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 消息创建时间（epoch ms）；缺失时不渲染时间戳/分隔线。 */
  at?: number;
  reasoning?: string;
  reasoningBlocks?: ReasoningBlock[];
  processMessages?: ProcessMessageRecord[];
  agentRounds?: AgentRoundRecord[];
  taskDelegations?: TaskDelegationDisplayRecord[];
  reasoningStreaming?: boolean;
  responseStarted?: boolean;
  streaming?: boolean;
  loading?: boolean;
  /** 请求已发出但尚未收到 Think、工具或正文等首个可视事件。 */
  waitingForFirstEvent?: boolean;
  ttsCacheKey?: string;
  ttsCacheVersion?: string;
  sticker?: string | null;
  toolExecutions?: ToolExecutionRecord[];
  runActivity?: RunActivityRecord;
  runStage?: AgentRunStage;
  /** 关联的 Run ID，用于获取 Review 快照 */
  runId?: string;
  taskPlan?: TaskPlanPresentation;
  attachments?: ChatMessageAttachment[];
  weather?: WeatherData;
  /** 上下文容量快照：运行中为每轮 preRequest 实时值，run 结束后为终态快照。 */
  contextUsage?: ContextUsageSnapshot;
  /** 渠道群聊的发送者/引用等隐藏模型上下文；不直接渲染。 */
  modelContext?: string;
  channelSource?: ChatMessageChannelSource;
}

export interface ChatMessageAttachment {
  name: string;
  kind: string;
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  caption?: string;
  status?: string;
  reason?: string;
  imageSendMode?: "direct" | "caption";
}

interface ChatMessageListProps {
  messages: ChatMessageItem[];
  conversationId?: string;
  mode: ConversationMode;
  preferredAddress: string;
  stickerSize?: "small" | "standard" | "large";
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void;
  revisionBusy?: boolean;
  onEditLastUserMessage?: (messageId: string, content: string) => Promise<boolean>;
  onRegenerateLastResponse?: (userMessageId: string, assistantMessageId: string) => Promise<boolean>;
  onScrollToBottomVisibilityChange?: (visible: boolean) => void;
  onRegisterScrollToBottom?: (scroll: () => void) => void;
  /** 点击 Review 文件项时打开右侧检查面板 */
  onOpenReviewInspector?: (runId: string, fileIndex: number) => void;
  /** 当前在右侧检查面板打开的 Review 文件，用于气泡内文件列表的高亮联动 */
  activeReviewFile?: { runId: string; fileIndex: number } | null;
}

const markdownConfig = { extensions: Latex() };
const cyreneAvatarUrl = resolveAsset("avatars/cyrene-avatar.png");

// 消息是否正在流式输出。code 渲染器收不到 MarkdownContent 的 props，用 context 传下去，
// mermaid 块靠它在流式期间显示占位而不是渲染半截语法
const MessageStreamingContext = createContext(false);

function MarkdownCode({ children, lang, block }: ComponentProps<{ children?: ReactNode }>) {
  const streaming = useContext(MessageStreamingContext);
  if (!block) return <code>{children}</code>;
  const source = String(children ?? "").replace(/\n$/, "");
  if ((lang ?? "").split(/\s+/)[0] === "mermaid") {
    return <MermaidBlock code={source} streaming={streaming} />;
  }
  if ((lang ?? "").split(/\s+/)[0] === "svg") {
    return <SvgCardBlock code={source} streaming={streaming} />;
  }
  return (
    <CollapsibleCodeBlock>
      <CodeHighlighter lang={(lang ?? "text").split(/\s+/)[0]} prismLightMode={false}>
        {source}
      </CodeHighlighter>
    </CollapsibleCodeBlock>
  );
}

/** 长代码折叠阈值（px）：超过后渐隐遮罩 + 展开/收起按钮。 */
const CODE_COLLAPSE_THRESHOLD = 360;

function CollapsibleCodeBlock({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setOverflowing(el.scrollHeight > CODE_COLLAPSE_THRESHOLD + 60);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const collapsed = overflowing && !expanded;
  return (
    <div className={`cy-code-collapse${collapsed ? " is-collapsed" : ""}`}>
      <div
        ref={bodyRef}
        className="cy-code-collapse__body"
        style={collapsed ? { maxHeight: CODE_COLLAPSE_THRESHOLD } : undefined}
      >
        {children}
      </div>
      {overflowing && (
        <div className="cy-code-collapse__overlay">
          <div className="cy-code-collapse__fade" aria-hidden="true" />
          <button
            type="button"
            className="cy-code-collapse__toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? t("messageList.codeCollapse.collapse") : t("messageList.codeCollapse.expand")}
          </button>
        </div>
      )}
    </div>
  );
}

/** markdown 图片：统一圆角边框，点击放大（antd Image 预览层）。 */
function MarkdownImage({ src, alt }: ComponentProps<{ src?: string; alt?: string }>) {
  if (!src) return null;
  return (
    <AntImage
      className="cy-message-markdown__image"
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      draggable={false}
    />
  );
}

const markdownComponents = { code: MarkdownCode, img: MarkdownImage };
const completedMarkdownOptions = {
  hasNextChunk: false,
  enableAnimation: false,
  tail: false,
};
// 流式中的消息：hasNextChunk 开启 x-markdown 的增量缓存（未闭合的公式/链接/表格先 hold-back，
// 不再“先渲染成文本再跳变”），尾部光标 + 新文本淡入给“正在生成”的视觉锚点
const streamingMarkdownOptions = {
  hasNextChunk: true,
  enableAnimation: true,
  tail: true,
};

class MarkdownRenderBoundary extends Component<{
  content: string;
  children: ReactNode;
}, { failed: boolean; failedAtLength: number; retries: number }> {
  // 流式早期的半截内容（未闭合公式/围栏等）可能让解析器抛错；内容继续增长后重试渲染，
  // 连续失败超过上限则保持降级，避免每个 delta 都闪烁 pre↔markdown
  static MAX_RETRIES = 5;

  state = { failed: false, failedAtLength: -1, retries: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { content: string },
    state: { failed: boolean; failedAtLength: number; retries: number },
  ): Partial<{ failed: boolean }> | null {
    if (state.failed && state.retries < MarkdownRenderBoundary.MAX_RETRIES && props.content.length > state.failedAtLength) {
      return { failed: false };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ReactChat] Markdown/KaTeX 渲染失败，已降级为原始文本", error, info);
    this.setState((state) => ({ failedAtLength: this.props.content.length, retries: state.retries + 1 }));
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <pre className="cy-message-markdown-fallback">{this.props.content}</pre>;
    }
    return this.props.children;
  }
}

export function MarkdownContent({ content, streaming }: { content: string; streaming?: boolean }) {
  // 模型偶尔输出畸形 Markdown（# 后缺空格、标题粘正文、围栏粘句子），
  // 渲染前先做机械归一化；归一化与 XMarkdown 解析都在同一 memo 周期内完成
  const normalized = useMemo(() => normalizeModelMarkdown(content), [content]);
  return (
    <MarkdownRenderBoundary content={normalized}>
      <MessageStreamingContext.Provider value={Boolean(streaming)}>
        <XMarkdown
          content={normalized}
          config={markdownConfig}
          components={markdownComponents}
          openLinksInNewTab
          escapeRawHtml
          rootClassName="cy-message-markdown"
          streaming={streaming ? streamingMarkdownOptions : completedMarkdownOptions}
        />
      </MessageStreamingContext.Provider>
    </MarkdownRenderBoundary>
  );
}

interface EnabledSticker {
  id: string;
  src: string;
}

function resolveStickerUrl(id: string, stickers: EnabledSticker[]): string | undefined {
  const raw = stickers.find((sticker) => sticker.id === id)?.src;
  if (!raw) return undefined;
  return raw.startsWith("/stickers/") ? resolveAsset(raw) : raw;
}

function AssistantContent({
  content,
  streaming,
  stickerUrl,
  channelSource,
}: {
  content: string;
  streaming: boolean;
  stickerUrl?: string;
  channelSource?: ChatMessageChannelSource;
}) {
  const { t } = useTranslation();
  return (
    <div className="cy-message__assistant-body">
      {channelSource && <ChannelSourceLabel source={channelSource} direction="outgoing" />}
      {content && <MarkdownContent content={content} streaming={streaming} />}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt={t("messageList.assistantStickerAlt")} draggable={false} />}
    </div>
  );
}

const channelNameKeys: Record<ChatMessageChannelSource["channel"], string> = {
  wechat: "messageList.channelSource.wechat",
  feishu: "messageList.channelSource.feishu",
  qq: "messageList.channelSource.qq",
  qqbot: "messageList.channelSource.qqbot",
};

function ChannelSourceLabel({
  source,
  direction,
}: {
  source: ChatMessageChannelSource;
  direction: "incoming" | "outgoing";
}) {
  const label = formatChannelSourceLabel(source, direction);
  return label ? <span className="cy-message__channel-source">{label}</span> : null;
}

export function formatChannelSourceLabel(
  source: ChatMessageChannelSource,
  direction: "incoming" | "outgoing",
): string {
  if (direction === "outgoing" || source.chatType !== "group") return "";
  return source.senderName?.trim() ?? "";
}

function channelName(channel: ChatMessageChannelSource["channel"]): string {
  const key = channelNameKeys[channel];
  return key ? t(key) : t("messageList.channelSource.unknown");
}

/** 把逐条来源提示收拢为会话级提示，避免每个气泡都像日志。 */
export function resolveChannelConversationLabel(
  messages: readonly Pick<ChatMessageItem, "channelSource">[],
): string | null {
  const channels = Array.from(new Set(
    messages
      .map((message) => message.channelSource?.channel)
      .filter((channel): channel is ChatMessageChannelSource["channel"] => Boolean(channel)),
  ));
  if (channels.length === 0) return null;
  return t("messageList.channelSource.sameConversation", {
    channels: channels.map(channelName).join("、"),
  });
}

function DotSpinner() {
  const { t } = useTranslation();
  return (
    <span className="cy-dot-spinner" aria-label={t("messageList.loadingAria")} role="status">
      {Array.from({ length: 8 }, (_, index) => <span className="cy-dot-spinner__dot" key={index} />)}
    </span>
  );
}

function ModelWaitContent() {
  const { t } = useTranslation();
  return (
    <section className="cy-model-wait" aria-label={t("messageList.modelWaitAria")}>
      <span className="cy-model-wait__art" aria-hidden="true">
        <img src={connectingMoodUrl} alt="" draggable={false} />
        <DotSpinner />
      </span>
      <span>{t("messageList.modelWaitText")}</span>
    </section>
  );
}

function ReasoningContent({
  content,
  loading,
  expanded,
  onExpand,
}: {
  content: string;
  loading: boolean;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Think
      rootClassName="cy-message-reasoning"
      title={loading ? t("messageList.thinkingTitle") : t("messageList.thinkingDoneTitle")}
      icon={
        <span className={`cy-reasoning-status-art${loading ? " is-thinking" : " is-complete"}`} aria-hidden="true">
          <img src={thinkingMoodUrl} alt="" draggable={false} />
          {loading && <DotSpinner />}
        </span>
      }
      blink={loading}
      expanded={expanded}
      onExpand={onExpand}
      destroyOnHidden
    >
      {content && <MarkdownContent content={content} streaming={loading} />}
    </Think>
  );
}

function useRunActivityNow(processing: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!processing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [processing]);
  return now;
}

function RunActivityReasoningBlock({ block }: { block: ReasoningBlock }) {
  const streaming = Boolean(block.streaming);
  // 与纯聊天模式保持一致：思考块默认折叠（含流式生成期间），仅用户点击后展开
  const [expanded, setExpanded] = useState(false);
  return (
    <ReasoningContent
      content={block.content}
      loading={streaming}
      expanded={expanded}
      onExpand={setExpanded}
    />
  );
}

function AgentRoundGroup({
  round,
  reasoningBlocks,
  processMessages,
  taskDelegations,
  tools,
  interrupted,
}: {
  round: AgentRoundRecord;
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  taskDelegations: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  interrupted: boolean;
}) {
  const { t } = useTranslation();
  const running = round.status === "running" && !interrupted;
  const [expanded, setExpanded] = useState(running);
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (!wasRunningRef.current && running) setExpanded(true);
    if (wasRunningRef.current && !running) setExpanded(false);
    wasRunningRef.current = running;
  }, [running]);

  const roundArt = interrupted
    ? interruptedMoodUrl
    : running
      ? workingMoodUrl
      : completedThinkingMoodUrl;

  return (
    <section className={`cy-agent-round${running ? " is-running" : " is-complete"}`}>
      {processMessages.filter((message) => message.content.trim()).map((message) => (
        <div className="cy-run-activity__process" key={message.id}>
          <MarkdownContent content={message.content} />
        </div>
      ))}
      {taskDelegations.map((delegation) => (
        <TaskDelegationRow delegation={delegation} key={delegation.invocationId} />
      ))}
      <button
        type="button"
        className="cy-agent-round__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="cy-agent-round__art" aria-hidden="true">
          <img
            className="cy-agent-round__art-image"
            src={roundArt}
            alt=""
            draggable={false}
          />
        </span>
        <span className="cy-agent-round__title">
          {resolveAgentRoundTitle(round, tools, interrupted)}
          {!interrupted && round.status !== "running" && countRoundChangedFiles(tools) > 0 && (
            <span className="cy-agent-round__files"> · {t("messageList.roundChangedFiles", { count: countRoundChangedFiles(tools) })}</span>
          )}
        </span>
        <svg className={`cy-agent-round__chevron${expanded ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
      {expanded && (
        <div className="cy-agent-round__body">
          {reasoningBlocks.filter((block) => block.content.trim()).map((block) => (
            <RunActivityReasoningBlock block={block} key={block.id} />
          ))}
          {tools.length > 0 && <ToolExecutionContent tools={tools} />}
        </div>
      )}
    </section>
  );
}

export function RunActivityDetail({
  agentRounds = [],
  reasoningBlocks,
  processMessages,
  taskDelegations = [],
  tools,
  interrupted = false,
}: {
  agentRounds?: AgentRoundRecord[];
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  taskDelegations?: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  interrupted?: boolean;
}) {
  const { t } = useTranslation();
  if (agentRounds.length > 0) {
    const visibleRounds = agentRounds.filter((round) =>
      processMessages.some((message) => message.roundId === round.id && message.content.trim())
      || reasoningBlocks.some((block) => block.roundId === round.id && block.content.trim())
      || taskDelegations.some((delegation) => delegation.roundId === round.id)
      || tools.some((tool) => tool.roundId === round.id));
    if (visibleRounds.length === 0) {
      return <div className="cy-run-activity__empty">{t("messageList.organizingReply")}</div>;
    }
    return (
      <div className="cy-run-activity__detail">
        {visibleRounds.map((round) => (
          <AgentRoundGroup
            key={round.id}
            round={round}
            interrupted={interrupted && round.status === "running"}
            processMessages={processMessages.filter((message) => message.roundId === round.id)}
            taskDelegations={taskDelegations.filter((delegation) => delegation.roundId === round.id)}
            reasoningBlocks={reasoningBlocks.filter((block) => block.roundId === round.id)}
            tools={tools.filter((tool) => tool.roundId === round.id)}
          />
        ))}
      </div>
    );
  }
  const timeline: ReactNode[] = [];
  taskDelegations.forEach((delegation) => {
    timeline.push(<TaskDelegationRow delegation={delegation} key={`task-${delegation.invocationId}`} />);
  });
  for (let index = 0; index <= tools.length; index += 1) {
    processMessages
      .filter((message) => (message.afterToolCount ?? 0) === index)
      .forEach((message) => {
        if (!message.content.trim()) return;
        timeline.push(
          <div className="cy-run-activity__process" key={`process-${message.id}`}>
            <MarkdownContent content={message.content} />
          </div>,
        );
      });
    reasoningBlocks
      .filter((block) => (block.afterToolCount ?? 0) === index)
      .forEach((block) => {
        if (!block.content.trim()) return;
        timeline.push(
          <RunActivityReasoningBlock
            key={`reasoning-${block.id}`}
            block={block}
          />,
        );
      });
    if (index < tools.length) {
      timeline.push(<ToolExecutionContent key={`tool-${tools[index].id}`} tools={[tools[index]]} />);
    }
  }
  return timeline.length
    ? <div className="cy-run-activity__detail">{timeline}</div>
    : <div className="cy-run-activity__empty">{t("messageList.organizingReply")}</div>;
}

/** 活动标题单独成组件：秒级计时只重渲染标题文本，不连带重渲染展开的过程面板。 */
function RunActivityTitle({ activity }: { activity: RunActivityRecord }) {
  const { t } = useTranslation();
  const now = useRunActivityNow(activity.completedAt === undefined);
  const snapshot = resolveRunActivitySnapshot(activity, now);
  return (
    <span>
      {snapshot.processing
        ? t("messageList.activityProcessingTitle", { elapsed: formatElapsed(snapshot.processingMs) })
        : t("messageList.activityProcessedTitle", { elapsed: formatElapsed(snapshot.processingMs) })}
    </span>
  );
}

function RunActivityContent({
  activityId,
  activity,
  reasoningBlocks,
  processMessages,
  agentRounds,
  taskDelegations,
  tools,
  stage,
  taskPlan,
  expanded,
  onExpand,
}: {
  activityId: string;
  activity: RunActivityRecord;
  reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[];
  agentRounds: AgentRoundRecord[];
  taskDelegations: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[];
  stage?: AgentRunStage;
  taskPlan?: TaskPlanPresentation;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  // 头部图标/折叠只依赖 processing 布尔值，不需要每秒 tick 的 now
  const snapshot = resolveRunActivitySnapshot(activity, activity.startedAt);
  const wasProcessingRef = useRef(snapshot.processing);
  useEffect(() => {
    if (shouldAutoCollapseRunActivity(wasProcessingRef.current, snapshot.processing, activity.keepExpanded)) onExpand(false);
    wasProcessingRef.current = snapshot.processing;
  }, [activity.keepExpanded, onExpand, snapshot.processing]);

  const image = snapshot.processing ? workingMoodUrl : processedMoodUrl;

  return (
    <section className={`cy-run-activity${snapshot.processing ? " is-processing" : " is-complete"}`}>
      <button
        type="button"
        className="cy-run-activity__header"
        onClick={() => onExpand(!expanded)}
        aria-expanded={expanded}
        aria-controls={`${activityId}-details`}
      >
        <span className="cy-run-activity__title">
            <span className="cy-run-activity__art" aria-hidden="true">
              <img src={image} alt="" draggable={false} />
              {snapshot.processing && <DotSpinner />}
            </span>
            <RunActivityTitle activity={activity} />
            {stage && <RunStageIndicator stage={stage} />}
        </span>
        <svg className={`cy-run-activity__chevron${expanded ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
      {expanded && (
        <div className="cy-run-activity__expanded" id={`${activityId}-details`}>
          {taskPlan && <TaskPlanCard plan={taskPlan} />}
          <div className="cy-run-activity__divider" />
          <RunActivityDetail
            agentRounds={agentRounds}
            reasoningBlocks={reasoningBlocks}
            processMessages={processMessages}
            taskDelegations={taskDelegations}
            tools={tools}
            interrupted={Boolean(activity.keepExpanded && activity.completedAt !== undefined)}
          />
          <div className="cy-run-activity__divider" />
        </div>
      )}
    </section>
  );
}

function ToolExecutionContent({ tools }: { tools: ToolExecutionRecord[] }) {
  const { t } = useTranslation();
  return (
    <section className="cy-tool-executions" aria-label={t("messageList.toolExecutionsAria")}>
      <ThoughtChain
        rootClassName="cy-tool-executions__chain"
        line="dashed"
        items={tools.map((tool) => {
          const presentation = describeToolExecution(tool);
          return {
            key: tool.id,
            title: presentation.label,
            description: (
              <span className="cy-tool-executions__description">
                <span className="cy-tool-executions__status">{presentation.statusText}</span>
                {presentation.detail && <code className="cy-tool-executions__detail">{presentation.detail}</code>}
              </span>
            ),
            status: tool.status === "running" ? "loading" : tool.status === "error" ? "error" : "success",
            blink: tool.status === "running",
            collapsible: Boolean(tool.result || tool.changes),
            content: (tool.result || tool.changes)
              ? <ToolResultContent result={tool.result} changes={tool.changes} />
              : undefined,
          };
        })}
      />
    </section>
  );
}

/** 工具结果展示：优先用事件携带的结构化 changes 渲染 Diff Review 卡片；否则尝试解析完整 result JSON；最后原样展示 */
function ToolResultContent({ result, changes }: { result?: string; changes?: ToolFileChange[] }) {
  if (changes && changes.length > 0) return <FileChangeCard changes={changes} />;
  if (result) {
    const parsed = extractFileChanges(result);
    if (parsed) return <FileChangeCard changes={parsed} />;
    return <pre className="cy-tool-executions__result">{result}</pre>;
  }
  return null;
}

function attachmentStatus(attachment: ChatMessageAttachment): string | undefined {
  if (attachment.status === "processing") return t("messageList.attachmentProcessing");
  if (attachment.status === "error") return attachment.reason ?? t("messageList.attachmentErrorFallback");
  if (attachment.imageSendMode === "direct") return t("messageList.attachmentDirect");
  if (attachment.imageSendMode === "caption" && attachment.status === "done") return t("messageList.attachmentDone");
  return undefined;
}

function UserAttachments({ attachments }: { attachments: ChatMessageAttachment[] }) {
  useTranslation();
  if (attachments.length === 0) return null;
  return (
    <div className="cy-message__attachments">
      {attachments.map((attachment, index) => {
        const status = attachmentStatus(attachment);
        if (attachment.kind === "image" && (attachment.previewUrl || attachment.filePath)) {
          return (
            <figure className="cy-message__image-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>
              <AttachmentImage attachment={attachment} />
              {status && <figcaption className={attachment.status === "error" ? "is-error" : ""}>{status}</figcaption>}
            </figure>
          );
        }
        return <span className="cy-message__file-attachment" key={`${attachment.filePath ?? attachment.name}-${index}`}>{attachment.name}</span>;
      })}
    </div>
  );
}

function AttachmentImage({ attachment }: { attachment: ChatMessageAttachment }) {
  const [src, setSrc] = useState(attachment.previewUrl);
  const [previewOpen, setPreviewOpen] = useState(false);
  // blob: 预览 URL 只在当前页面有效，聊天记录持久化后刷新必失效；只允许一次磁盘重读兜底
  const diskFallbackTriedRef = useRef(false);

  function readFromDisk(): void {
    if (!attachment.filePath) return;
    void window.chat?.getImagePreview?.(attachment.filePath).then((result) => {
      if (result.ok && result.dataUrl) setSrc(result.dataUrl);
    });
  }

  useEffect(() => {
    setSrc(attachment.previewUrl);
    diskFallbackTriedRef.current = false;
    if ((!attachment.previewUrl || attachment.previewUrl.startsWith("file:")) && attachment.filePath) {
      let active = true;
      void window.chat?.getImagePreview?.(attachment.filePath).then((result) => {
        if (active && result.ok && result.dataUrl) setSrc(result.dataUrl);
      });
      return () => {
        active = false;
      };
    }
  }, [attachment.filePath, attachment.previewUrl]);

  // 历史 blob: URL 加载失败时从磁盘重读，修复刷新后的存量裂图
  function handleImageError(): void {
    if (diskFallbackTriedRef.current) return;
    diskFallbackTriedRef.current = true;
    readFromDisk();
  }

  return (
    <>
      <img
        src={src}
        alt={attachment.name}
        draggable={false}
        className="is-zoomable"
        onClick={() => setPreviewOpen(true)}
        onError={handleImageError}
      />
      {/* 隐藏的 Image 仅承载 antd 预览层；展示仍用原生 img 以保留磁盘重读兜底 */}
      <AntImage
        src={src}
        alt={attachment.name}
        style={{ display: "none" }}
        preview={{
          visible: previewOpen,
          src,
          onVisibleChange: setPreviewOpen,
        }}
      />
    </>
  );
}

function UserContent({
  content,
  stickerUrl,
  attachments = [],
  channelSource,
}: {
  content: string;
  stickerUrl?: string;
  attachments?: ChatMessageAttachment[];
  channelSource?: ChatMessageChannelSource;
}) {
  const { t } = useTranslation();
  return (
    <div className="cy-message__user-body">
      {channelSource && <ChannelSourceLabel source={channelSource} direction="incoming" />}
      <UserAttachments attachments={attachments} />
      {content && <MarkdownContent content={content} />}
      {stickerUrl && <img className="cy-message__sticker" src={stickerUrl} alt={t("messageList.userStickerAlt")} draggable={false} />}
    </div>
  );
}

function LastUserMessageEditor({
  initialContent,
  busy,
  onCancel,
  onSubmit,
}: {
  initialContent: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (draft: string) => void;
}) {
  const { t } = useTranslation();
  // 草稿内聚在编辑器内部：打字不触发消息列表整体重渲染（roles 不再依赖草稿文本）
  const [draft, setDraft] = useState(initialContent);
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit(draft);
    }
  };
  return (
    <div className="cy-last-message-editor">
      <textarea
        autoFocus
        value={draft}
        disabled={busy}
        aria-label={t("messageList.editLastMessageAria")}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="cy-last-message-editor__actions">
        <button type="button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="is-primary" disabled={busy || !draft.trim()} onClick={() => onSubmit(draft)}>
          {t("messageList.saveAndRegenerate")}
        </button>
      </div>
    </div>
  );
}

function CyreneMessageAvatar() {
  const { t } = useTranslation();
  return <img className="cy-message-avatar__image" src={cyreneAvatarUrl} alt={t("messageList.cyreneAvatarAlt")} draggable={false} />;
}

function UserMessageAvatar({ src }: { src: string | null }) {
  const { t } = useTranslation();
  if (src) return <img className="cy-message-avatar__image" src={src} alt={t("messageList.userAvatarAlt")} draggable={false} />;
  return <span className="cy-message-avatar__user" aria-label={t("messageList.userAvatarAlt")} />;
}

function createRoles(
  userAvatarUrl: string | null,
  conversationId: string | undefined,
  mode: ConversationMode,
  preferredAddress: string,
  lastTurn: RevisableLastTurn | null,
  editingMessageId: string | null,
  revisionBusy: boolean,
  onBeginEdit: (messageId: string) => void,
  onCancelEdit: () => void,
  onSubmitEdit: (messageId: string, draft: string) => void,
  onRegenerate: () => void,
  reasoningExpanded: Readonly<Record<string, boolean>>,
  onReasoningExpand: (id: string, expanded: boolean) => void,
  onTtsCacheKey?: (messageId: string, cacheKey: string, converterVersion: string) => void,
  onOpenReviewInspector?: (runId: string, fileIndex: number) => void,
  activeReviewFile?: { runId: string; fileIndex: number } | null,
) {
  return {
  user: {
    placement: "end" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--user",
    avatar: <UserMessageAvatar src={userAvatarUrl} />,
    contentRender: (content: string, info: { extraInfo?: { at?: number; messageId?: string; stickerUrl?: string; attachments?: ChatMessageAttachment[]; channelSource?: ChatMessageChannelSource } }) => (
      info.extraInfo?.messageId === editingMessageId
        ? <LastUserMessageEditor
            initialContent={content}
            busy={revisionBusy}
            onCancel={onCancelEdit}
            onSubmit={(draft) => onSubmitEdit(info.extraInfo?.messageId ?? "", draft)}
          />
        : <UserContent
            content={content}
            stickerUrl={info.extraInfo?.stickerUrl}
            attachments={info.extraInfo?.attachments}
            channelSource={info.extraInfo?.channelSource}
          />
    ),
    footer: (content: string, info: { extraInfo?: { at?: number; messageId?: string } }) => {
      const cleanText = content.replace(/\[sticker:[^\]]+\]/g, "").trim();
      const messageId = info.extraInfo?.messageId;
      if (messageId === editingMessageId) return null;
      const showEdit = messageId === lastTurn?.userMessageId;
      const time = info.extraInfo?.at;
      if (!cleanText && !showEdit && time === undefined) return null;
      return (
        <div className="cy-message-actions">
          {time !== undefined && <span className="cy-message-time">{formatMessageClock(time)}</span>}
          {showEdit && (
            <LastTurnActionButton
              kind="edit"
              disabled={revisionBusy}
              onClick={() => onBeginEdit(messageId, cleanText)}
            />
          )}
          {cleanText && <CopyButton text={cleanText} />}
        </div>
      );
    },
  },
  assistant: {
    placement: "start" as const,
    variant: "filled" as const,
    rootClassName: "cy-message cy-message--assistant",
    avatar: <CyreneMessageAvatar />,
    contentRender: (content: string, info: { extraInfo?: { streaming?: boolean; stickerUrl?: string; channelSource?: ChatMessageChannelSource } }) => (
      <AssistantContent
        content={content}
        streaming={Boolean(info.extraInfo?.streaming)}
        stickerUrl={info.extraInfo?.stickerUrl}
        channelSource={info.extraInfo?.channelSource}
      />
    ),
    footer: (content: string, info: { extraInfo?: { at?: number; messageId?: string; streaming?: boolean; ttsCacheKey?: string } }) => {
      const cleanText = content.trim();
      const messageId = info.extraInfo?.messageId;
      const canRegenerate = messageId === lastTurn?.assistantMessageId;
      const time = info.extraInfo?.at;
      const timeNode = time === undefined
        ? null
        : <span className="cy-message-time">{formatMessageClock(time)}</span>;
      if (info.extraInfo?.streaming) return timeNode ? <div className="cy-message-actions">{timeNode}</div> : null;
      if (!cleanText && !canRegenerate && !timeNode) return null;
      return (
        <div className="cy-message-actions">
          {timeNode}
          {cleanText && messageId && conversationId && (
            <TtsButton
              conversationId={conversationId}
              messageId={messageId}
              text={cleanText}
              speechMode={mode === "learn" ? "learn" : "default"}
              preferredAddress={preferredAddress}
              onCacheKey={(cacheKey, converterVersion) => onTtsCacheKey?.(messageId, cacheKey, converterVersion)}
            />
          )}
          {cleanText && <CopyButton text={cleanText} />}
          {canRegenerate && (
            <LastTurnActionButton kind="regenerate" disabled={revisionBusy} onClick={onRegenerate} />
          )}
        </div>
      );
    },
  },
  reasoning: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--reasoning",
    contentRender: (_content: string, info: { extraInfo?: { reasoningId?: string; reasoning?: string; reasoningStreaming?: boolean } }) => (
      <ReasoningContent
        content={info.extraInfo?.reasoning ?? ""}
        loading={Boolean(info.extraInfo?.reasoningStreaming)}
        expanded={info.extraInfo?.reasoningId
          ? resolveReasoningExpanded(reasoningExpanded, info.extraInfo.reasoningId)
          : false}
        onExpand={(expanded) => {
          if (info.extraInfo?.reasoningId) onReasoningExpand(info.extraInfo.reasoningId, expanded);
        }}
      />
    ),
  },
  activity: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--activity",
    contentRender: (_content: string, info: {
      extraInfo?: {
        activityId?: string;
        activity?: RunActivityRecord;
        reasoningBlocks?: ReasoningBlock[];
        processMessages?: ProcessMessageRecord[];
        agentRounds?: AgentRoundRecord[];
        taskDelegations?: TaskDelegationDisplayRecord[];
        tools?: ToolExecutionRecord[];
        runStage?: AgentRunStage;
        taskPlan?: TaskPlanPresentation;
      };
    }) => {
      const activityId = info.extraInfo?.activityId;
      const activity = info.extraInfo?.activity;
      if (!activityId || !activity) return null;
      return (
        <RunActivityContent
          activityId={activityId}
          activity={activity}
          reasoningBlocks={info.extraInfo?.reasoningBlocks ?? []}
          processMessages={info.extraInfo?.processMessages ?? []}
          agentRounds={info.extraInfo?.agentRounds ?? []}
          taskDelegations={info.extraInfo?.taskDelegations ?? []}
          tools={info.extraInfo?.tools ?? []}
          stage={info.extraInfo?.runStage}
          taskPlan={info.extraInfo?.taskPlan}
          expanded={resolveRunActivityExpanded(reasoningExpanded, activityId, activity)}
          onExpand={(expanded) => onReasoningExpand(activityId, expanded)}
        />
      );
    },
  },
  tool: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--tool",
    contentRender: (_content: string, info: { extraInfo?: { tools?: ToolExecutionRecord[] } }) => (
      info.extraInfo?.tools?.length ? <ToolExecutionContent tools={info.extraInfo.tools} /> : null
    ),
  },
  waiting: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--waiting",
    contentRender: () => <ModelWaitContent />,
  },
  weather: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--weather",
    contentRender: (_content: string, info: { extraInfo?: { weather?: WeatherData } }) => (
      info.extraInfo?.weather ? <WeatherCard data={info.extraInfo.weather} /> : null
    ),
  },
  review: {
    placement: "start" as const,
    variant: "borderless" as const,
    avatar: null,
    rootClassName: "cy-message cy-message--review",
    contentRender: (_content: string, info: { extraInfo?: { runId?: string } }) => (
      info.extraInfo?.runId
        ? <ReviewPanel
            runId={info.extraInfo.runId}
            activeFileIndex={activeReviewFile?.runId === info.extraInfo.runId ? activeReviewFile.fileIndex : undefined}
            onOpenInspector={onOpenReviewInspector}
          />
        : null
    ),
  },
  system: {
    placement: "start" as const,
    variant: "borderless" as const,
    rootClassName: "cy-message cy-message--system",
  },
  };
}

export function createMessageItems(messages: ChatMessageItem[], enabledStickers: EnabledSticker[]): BubbleItemType[] {
  const items: BubbleItemType[] = [];
  let lastDayKey: string | null = null;
  for (const message of messages) {
    // 跨天分隔线：仅统计带时间戳的消息，缺失 at 的消息不打断日期序列
    if (message.at !== undefined) {
      const dayKey = new Date(message.at).toDateString();
      if (dayKey !== lastDayKey) {
        items.push({
          key: `${message.id}-day`,
          role: "divider",
          content: formatDayDivider(message.at),
        });
      }
      lastDayKey = dayKey;
    }
    if (message.role !== "assistant") {
      const stickerId = extractMessageStickerId(message.content, message.sticker);
      items.push({
        key: message.id,
        role: message.role,
        content: stripMessageStickerMarkers(message.content),
        extraInfo: {
          at: message.at,
          stickerUrl: stickerId ? resolveStickerUrl(stickerId, enabledStickers) : undefined,
          attachments: message.attachments,
          messageId: message.id,
          channelSource: message.channelSource,
        },
      });
      continue;
    }

    const stages = assistantRenderStages(message);
    if (message.waitingForFirstEvent && !message.runActivity) {
      items.push({
        key: `${message.id}-waiting`,
        role: "waiting",
        content: "",
      });
    }
    const reasoningBlocks = message.reasoningBlocks?.length
      ? message.reasoningBlocks
      : (stages.includes("reasoning") ? [{ id: `${message.id}-legacy`, content: message.reasoning ?? "", streaming: message.reasoningStreaming }] : []);
    const appendReasoning = (block: ReasoningBlock) => {
      items.push({
        key: `${message.id}-reasoning-${block.id}`,
        role: "reasoning",
        content: "",
        extraInfo: {
          reasoningId: block.id,
          reasoning: block.content,
          reasoningStreaming: block.streaming,
        },
      });
    };
    const tools = message.toolExecutions ?? [];
    if (message.runActivity) {
      items.push({
        key: `${message.id}-activity`,
        role: "activity",
        content: "",
        extraInfo: {
          activityId: `${message.id}-activity`,
          activity: message.runActivity,
          reasoningBlocks,
          processMessages: message.processMessages ?? [],
          agentRounds: message.agentRounds ?? [],
          taskDelegations: message.taskDelegations ?? [],
          tools,
          runStage: message.runStage,
          taskPlan: message.taskPlan,
        },
      });
    } else {
      for (let index = 0; index <= tools.length; index += 1) {
        reasoningBlocks.filter((block) => (block.afterToolCount ?? 0) === index).forEach(appendReasoning);
        if (index === tools.length) continue;
        items.push({
          key: `${message.id}-tool-${tools[index].id}`,
          role: "tool",
          content: "",
          extraInfo: { tools: [tools[index]] },
        });
      }
    }
    if (message.weather) {
      items.push({
        key: `${message.id}-weather`,
        role: "weather",
        content: "",
        extraInfo: { weather: message.weather },
      });
    }
    if (stages.includes("assistant")) {
      items.push({
        key: message.id,
        role: "assistant",
        content: message.content,
        streaming: message.streaming,
        extraInfo: {
          messageId: message.id,
          at: message.at,
          streaming: message.streaming,
          ttsCacheKey: message.ttsCacheKey,
          stickerUrl: message.sticker ? resolveStickerUrl(message.sticker, enabledStickers) : undefined,
          channelSource: message.channelSource,
        },
      });
    }
    // Review 面板：Run 结束后（非 streaming/loading）且有 runId 时显示
    if (message.runId && !message.streaming && !message.loading) {
      items.push({
        key: `${message.id}-review`,
        role: "review",
        content: "",
        extraInfo: { runId: message.runId },
      });
    }
  }
  return items;
}

export function ChatMessageList({
  messages,
  conversationId,
  mode,
  preferredAddress,
  stickerSize = "standard",
  onTtsCacheKey,
  revisionBusy = false,
  onEditLastUserMessage,
  onRegenerateLastResponse,
  onScrollToBottomVisibilityChange,
  onRegisterScrollToBottom,
  onOpenReviewInspector,
  activeReviewFile,
}: ChatMessageListProps) {
  const userAvatarUrl = useUserAvatar();
  const [enabledStickers, setEnabledStickers] = useState<EnabledSticker[]>([]);
  const [reasoningExpanded, setReasoningExpanded] = useState<Record<string, boolean>>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const lastTurn = resolveRevisableLastTurn(messages, mode);
  const onReasoningExpand = useCallback((id: string, expanded: boolean) => {
    setReasoningExpanded((current) => updateReasoningExpanded(current, id, expanded));
  }, []);
  const beginEdit = useCallback((messageId: string) => {
    setEditingMessageId(messageId);
  }, []);
  const cancelEdit = useCallback(() => {
    if (revisionBusy) return;
    setEditingMessageId(null);
  }, [revisionBusy]);
  const submitEdit = useCallback((messageId: string, draft: string) => {
    const content = draft.trim();
    if (!messageId || !content || revisionBusy) return;
    void onEditLastUserMessage?.(messageId, content).then((accepted) => {
      if (!accepted) return;
      setEditingMessageId(null);
    });
  }, [onEditLastUserMessage, revisionBusy]);
  const regenerate = useCallback(() => {
    if (!lastTurn || !onRegenerateLastResponse || revisionBusy) return;
    void onRegenerateLastResponse(lastTurn.userMessageId, lastTurn.assistantMessageId);
  }, [lastTurn, onRegenerateLastResponse, revisionBusy]);

  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // antd-x 的 Bubble.List 自带内层滚动盒；这里关闭其 autoScroll 并在 CSS 中取消内层滚动，
  // 让外层 .cy-message-list 成为唯一滚动容器 —— 回到底部按钮、sticky 渠道横幅、切会话兜底滚动都挂在外层。
  // antd autoScroll 的“贴底跟随”由 ResizeObserver 等价实现：内容高度变化时若正贴底则继续贴底。
  useEffect(() => {
    const container = containerRef.current;
    const list = container?.querySelector(".ant-bubble-list");
    if (!container || !list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        container.scrollTo({ top: container.scrollHeight });
      }
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  // 向父组件注册滚动到底部的回调
  useEffect(() => {
    onRegisterScrollToBottom?.(scrollToBottom);
  }, [onRegisterScrollToBottom, scrollToBottom]);

  const updateScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < 100;
    isNearBottomRef.current = nearBottom;
    onScrollToBottomVisibilityChange?.(!nearBottom);
  }, [onScrollToBottomVisibilityChange]);

  // 打开/切换会话时滚动到底部；用 layout effect 在首帧绘制前完成，避免先见顶再跳底
  useLayoutEffect(() => {
    scrollToBottom("auto");
    // 内容渲染后再次兜底滚动
    const timer = window.setTimeout(() => scrollToBottom("auto"), 100);
    isNearBottomRef.current = true;
    onScrollToBottomVisibilityChange?.(false);
    return () => window.clearTimeout(timer);
  }, [conversationId, onScrollToBottomVisibilityChange, scrollToBottom]);

  const roles = useMemo(
    () => createRoles(
      userAvatarUrl,
      conversationId,
      mode,
      preferredAddress,
      lastTurn,
      editingMessageId,
      revisionBusy,
      beginEdit,
      cancelEdit,
      submitEdit,
      regenerate,
      reasoningExpanded,
      onReasoningExpand,
      onTtsCacheKey,
      onOpenReviewInspector,
      activeReviewFile,
    ),
    [activeReviewFile, beginEdit, cancelEdit, conversationId, editingMessageId, lastTurn, mode, onOpenReviewInspector, onReasoningExpand, onTtsCacheKey, preferredAddress, reasoningExpanded, regenerate, revisionBusy, submitEdit, userAvatarUrl],
  );

  useEffect(() => {
    if (editingMessageId && editingMessageId !== lastTurn?.userMessageId) {
      setEditingMessageId(null);
    }
  }, [editingMessageId, lastTurn?.userMessageId]);

  useEffect(() => stopTtsPlayback, [conversationId]);

  useEffect(() => {
    let active = true;
    void window.chat?.getEnabledStickers?.().then((stickers) => {
      if (active) setEnabledStickers(stickers);
    }).catch(() => {
      if (active) setEnabledStickers([]);
    });
    return () => {
      active = false;
    };
  }, []);

  const items = useMemo(
    () => createMessageItems(messages, enabledStickers),
    [messages, enabledStickers],
  );
  const channelConversationLabel = resolveChannelConversationLabel(messages);

  return (
    <div
      ref={containerRef}
      className={`cy-message-list cy-message-list--stickers-${stickerSize}`}
      aria-live="polite"
      onScroll={updateScrollState}
    >
      {channelConversationLabel && (
        <div className="cy-message-list__channel-context" role="note" aria-label={channelConversationLabel}>
          <span className="cy-message-list__channel-dot" aria-hidden="true" />
          <span>{channelConversationLabel}</span>
        </div>
      )}
      <Bubble.List items={items} role={roles} autoScroll={false} />
    </div>
  );
}
