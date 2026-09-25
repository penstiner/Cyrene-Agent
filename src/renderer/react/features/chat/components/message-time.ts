import { t } from "../../../i18n";

const DAY_MS = 86_400_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 消息气泡内的时刻显示：HH:mm（24 小时制）。 */
export function formatMessageClock(at: number): string {
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 跨天分隔线文案：今天 / 昨天 / M月D日 / 跨年补全年份。 */
export function formatDayDivider(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return t("messageList.dayDivider.today");
  if (date.toDateString() === new Date(now - DAY_MS).toDateString()) {
    return t("messageList.dayDivider.yesterday");
  }
  if (date.getFullYear() === today.getFullYear()) {
    return t("messageList.dayDivider.monthDay", { month: date.getMonth() + 1, day: date.getDate() });
  }
  return t("messageList.dayDivider.fullDate", {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}
