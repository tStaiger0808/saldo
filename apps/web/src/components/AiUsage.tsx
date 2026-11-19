import { useI18n } from "../i18n/react.tsx";
import type { Formatter } from "../lib/format.ts";
import type { getAiUsage } from "../server/functions/ai.ts";
import { Money, TableWrap } from "./Bits.tsx";
import { Tag } from "./Status.tsx";

export type Usage = Awaited<ReturnType<typeof getAiUsage>>;

export function formatCosts(f: Formatter, costs: Usage["totals"]["costs"]): string {
  if (costs.length === 0) return "–";
  return costs.map((c) => f.micro(c.micro, c.currency)).join(" + ");
}

export function UsageView({ usage }: { usage: Usage }) {
  const { t, f } = useI18n();
  const totals = usage.totals;
  return (
    <div className="stack">
      <dl className="kpis">
        <div className="kpi">
          <dt>{t("ai.usage.calls")}</dt>
          <dd className="kpi-value">{f.integer(totals.calls)}</dd>
        </div>
        <div className="kpi">
          <dt>{t("ai.usage.contextTokens")}</dt>
          <dd className="kpi-value">{f.integer(totals.inputTokens)}</dd>
          <dd className="kpi-meta">{t("ai.usage.largestRequest", { count: totals.maxInputTokens })}</dd>
        </div>
        <div className="kpi">
          <dt>{t("ai.usage.answerTokens")}</dt>
          <dd className="kpi-value">{f.integer(totals.outputTokens)}</dd>
        </div>
        <div className="kpi">
          <dt>{t("ai.usage.costs")}</dt>
          <dd className="kpi-value">
            <Money>{formatCosts(f, totals.costs)}</Money>
          </dd>
          {totals.unpricedCalls > 0 && <dd className="kpi-meta">{t("ai.usage.unpriced", { count: totals.unpricedCalls })}</dd>}
        </div>
      </dl>
      {usage.byModel.length > 0 && (
        <TableWrap>
          <table className="data-table">
            <caption className="visually-hidden">{t("ai.usage.byModel")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("common.fields.model")}</th>
                <th scope="col" className="num">
                  {t("ai.usage.calls")}
                </th>
                <th scope="col" className="num">
                  {t("ai.usage.context")}
                </th>
                <th scope="col" className="num">
                  {t("ai.usage.answer")}
                </th>
                <th scope="col" className="num">
                  {t("ai.usage.costs")}
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.byModel.map((g) => (
                <tr key={g.key}>
                  <td>{g.label}</td>
                  <td className="num">{f.integer(g.calls)}</td>
                  <td className="num">{f.integer(g.inputTokens)}</td>
                  <td className="num">{f.integer(g.outputTokens)}</td>
                  <td className="num">
                    <Money>{formatCosts(f, g.costs)}</Money>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {usage.byMonth.length > 1 && (
        <TableWrap>
          <table className="data-table">
            <caption className="visually-hidden">{t("ai.usage.byMonth")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("common.fields.month")}</th>
                <th scope="col" className="num">
                  {t("ai.usage.calls")}
                </th>
                <th scope="col" className="num">
                  {t("ai.usage.tokens")}
                </th>
                <th scope="col" className="num">
                  {t("ai.usage.costs")}
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.byMonth.map((m) => (
                <tr key={m.month}>
                  <td>{f.monthLong(m.month)}</td>
                  <td className="num">{f.integer(m.calls)}</td>
                  <td className="num">{f.integer(m.inputTokens + m.outputTokens)}</td>
                  <td className="num">
                    <Money>{formatCosts(f, m.costs)}</Money>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {usage.recent.length > 0 && (
        <details>
          <summary>{t("ai.usage.recent")}</summary>
          <ul className="list">
            {usage.recent.map((call) => (
              <li key={call.id}>
                <span className="list-main">
                  <span className="list-title">
                    {t(`ai.usage.purpose.${call.purpose}`)} <Tag>{call.model}</Tag>
                  </span>
                  <span className="list-sub">
                    {f.dateTime(call.createdAt)} · {call.username ?? t("ai.usage.deletedUser")} ·{" "}
                    {t("ai.usage.tokensLine", { input: call.inputTokens, output: call.outputTokens })}
                    {call.reported ? "" : t("ai.usage.estimated")}
                  </span>
                </span>
                <span className="num">
                  {call.costMicro === null ? "–" : <Money>{formatCosts(f, [{ currency: call.currency, micro: call.costMicro }])}</Money>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
