import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { TableWrap } from "../../../components/Bits.tsx";
import { ConfirmDialog, FormDialog } from "../../../components/Dialog.tsx";
import { Field } from "../../../components/Field.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Banner, NoticeBanner, Tag } from "../../../components/Status.tsx";
import { useT } from "../../../i18n/react.tsx";
import { useAction, useNotice } from "../../../lib/action.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { CATEGORY_KINDS, RULE_DIRECTIONS, RULE_FIELDS, type RuleDirection, type RuleField } from "../../../lib/labels.ts";
import { requireSection } from "../../../lib/settings.ts";
import { deleteRuleFn, getCategories, getRules, getTags, previewRuleFn, saveRuleFn } from "../../../server/functions/catalog.ts";

export const Route = createFileRoute("/_app/einstellungen/regeln")({
  beforeLoad: requireSection("regeln"),
  loader: async () => {
    const [rules, categories, tags] = await Promise.all([getRules(), getCategories(), getTags()]);
    return { rules, categories, tags };
  },
  component: RulesSection,
});

type Rule = Awaited<ReturnType<typeof getRules>>[number];
type SortColumn = "pattern" | "assignment" | "priority";
type Sort = { column: SortColumn; ascending: boolean };

const SORT_KEY = "fw-regeln-sortierung";
const DEFAULT_SORT: Sort = { column: "priority", ascending: false };

function readSort(): Sort {
  try {
    const value = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as Partial<Sort> | null;
    if (value && ["pattern", "assignment", "priority"].includes(value.column ?? "") && typeof value.ascending === "boolean")
      return value as Sort;
  } catch {
    // Unreadable or blocked storage: the default order.
  }
  return DEFAULT_SORT;
}

function sortRules(rules: readonly Rule[], sort: Sort, categoryName: (rule: Rule) => string): Rule[] {
  const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const compare: Record<SortColumn, (a: Rule, b: Rule) => number> = {
    pattern: (a, b) => text(a.pattern, b.pattern),
    assignment: (a, b) => text(categoryName(a), categoryName(b)),
    priority: (a, b) => a.priority - b.priority,
  };
  const direction = sort.ascending ? 1 : -1;
  return [...rules].sort((a, b) => direction * compare[sort.column](a, b) || text(a.pattern, b.pattern) || a.id - b.id);
}

/** A column head that sorts the table; a second click turns the order around. */
function SortableHead({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortColumn;
  sort: Sort;
  onSort: (sort: Sort) => void;
  className?: string;
}) {
  const t = useT();
  const active = sort.column === column;
  return (
    <th scope="col" className={className} aria-sort={active ? (sort.ascending ? "ascending" : "descending") : undefined}>
      <button
        type="button"
        className="sort-button"
        onClick={() => onSort({ column, ascending: active ? !sort.ascending : column !== "priority" })}
      >
        {label}
        <span className="sort-mark" data-active={active || undefined} aria-hidden="true">
          <Icon name={active && sort.ascending ? "up" : "down"} size={14} />
        </span>
        {!active && <span className="visually-hidden">, {t("transactions.sort.sortable")}</span>}
      </button>
    </th>
  );
}
type Category = Awaited<ReturnType<typeof getCategories>>[number];
type TagItem = Awaited<ReturnType<typeof getTags>>[number];

function RulesSection() {
  const { rules, categories, tags } = Route.useLoaderData();
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const { notice, setNotice, clear } = useNotice();
  const remove = useAction(deleteRuleFn);
  const t = useT();
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]));
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  useEffect(() => setSort(readSort()), []);
  const changeSort = (next: Sort) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
    } catch {
      // The order then lasts for this visit.
    }
  };
  const sorted = sortRules(rules, sort, (rule) => (rule.categoryId ? (categoryNames.get(rule.categoryId) ?? "") : ""));

  async function destroy(rule: Rule) {
    const result = await remove.run({ data: { id: rule.id } });
    setNotice(
      result.ok ? { tone: "ok", text: t("settings.rules.deleted", { pattern: rule.pattern }) } : { tone: "danger", text: result.error },
    );
  }

  return (
    <>
      <NoticeBanner notice={notice} onClose={clear} />
      <section className="card card-flush" aria-labelledby="rules-title">
        <div className="card-head">
          <h2 id="rules-title">{t("settings.rules.count", { count: rules.length })}</h2>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
              <Icon name="plus" size={18} /> {t("settings.rules.create")}
            </button>
          </div>
        </div>
        <p className="muted measure" style={{ padding: "0 20px 12px" }}>
          {t("settings.rules.intro")}
        </p>
        {rules.length === 0 ? (
          <p className="empty">{t("settings.rules.empty")}</p>
        ) : (
          <TableWrap>
            <table className="data-table responsive">
              <thead>
                <tr>
                  <SortableHead label={t("settings.rules.contains")} column="pattern" sort={sort} onSort={changeSort} />
                  <SortableHead label={t("settings.rules.assignment")} column="assignment" sort={sort} onSort={changeSort} />
                  <SortableHead label={t("settings.rules.priority")} column="priority" sort={sort} onSort={changeSort} className="num" />
                  <th scope="col" className="row-actions">
                    <span className="visually-hidden">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((rule) => (
                  <tr key={rule.id}>
                    <td className="span">
                      <span className="cell-main">
                        <span className="cell-title">{t("settings.rules.pattern", { pattern: rule.pattern })}</span>
                        <span className="cell-sub row">
                          {t("settings.rules.inField", { field: t(`labels.ruleField.${rule.field}`) })}
                          {" · "}
                          {t(`labels.ruleDirection.${rule.direction}`)} <Tag>{t(`settings.rules.source.${rule.source}`)}</Tag>
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="cell-main">
                        <span>
                          {rule.categoryId ? (
                            categoryNames.get(rule.categoryId)
                          ) : (
                            <span className="muted">{t("settings.rules.noCategory")}</span>
                          )}
                        </span>
                        {rule.tagIds.length > 0 && (
                          <span className="cell-sub">
                            {t("settings.rules.tagList", { names: rule.tagIds.map((id) => tagNames.get(id)).join(", ") })}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="num">
                      <span className="cell-main">
                        {rule.priority}
                        <span className="cell-sub cell-label" aria-hidden="true">
                          {t("settings.rules.priority")}
                        </span>
                      </span>
                    </td>
                    <td className="row-actions">
                      <span className="actions">
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(rule)}>
                          {t("common.edit")}
                          <span className="visually-hidden">: {rule.pattern}</span>
                        </button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeleting(rule)}>
                          {t("common.delete")}
                          <span className="visually-hidden">: {rule.pattern}</span>
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
      {editing && (
        <RuleDialog
          rule={editing === "new" ? null : editing}
          categories={categories}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={(text) => setNotice({ tone: "ok", text })}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("settings.rules.deleteTitle", { pattern: deleting?.pattern ?? "" })}
        confirmLabel={t("settings.rules.deleteConfirm")}
        danger
        onConfirm={() => deleting && destroy(deleting)}
        onClose={() => setDeleting(null)}
      >
        <p>{t("settings.rules.deleteText")}</p>
      </ConfirmDialog>
    </>
  );
}

function RuleDialog({
  rule,
  categories,
  tags,
  onClose,
  onSaved,
}: {
  rule: Rule | null;
  categories: Category[];
  tags: TagItem[];
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [field, setField] = useState<RuleField>(rule?.field ?? "any");
  const [direction, setDirection] = useState<RuleDirection>(rule?.direction ?? "any");
  const [categoryId, setCategoryId] = useState(rule?.categoryId ? String(rule.categoryId) : "");
  const [tagIds, setTagIds] = useState<number[]>(rule?.tagIds ?? []);
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [preview, setPreview] = useState<{ matchCount: number; examples: string[] } | null>(null);
  const { form, errors, check, clear } = useFormErrors<{ pattern: string; priority: string; target: string }>();
  const save = useAction(saveRuleFn);
  const previewAction = useAction(previewRuleFn, { invalidate: false });
  const t = useT();

  async function runPreview() {
    if (!check({ pattern: pattern.trim().length >= 2 ? undefined : t("settings.rules.minTwoChars") })) return;
    const result = await previewAction.run({ data: { pattern: pattern.trim(), field, direction } });
    if (result.ok) setPreview(result.value);
  }

  async function submit() {
    const n = Number(priority);
    if (
      !check({
        pattern: pattern.trim().length >= 2 ? undefined : t("settings.rules.minTwoChars"),
        priority: Number.isInteger(n) && n >= 0 && n <= 1000 ? undefined : t("settings.rules.priorityRange"),
        target: categoryId || tagIds.length > 0 ? undefined : t("settings.rules.targetRequired"),
      })
    )
      return;
    const result = await save.run({
      data: {
        id: rule?.id,
        pattern: pattern.trim(),
        field,
        direction,
        categoryId: categoryId ? Number(categoryId) : null,
        tagIds,
        priority: n,
      },
    });
    if (!result.ok) return;
    onSaved(rule ? t("settings.rules.saved") : t("settings.rules.created"));
    onClose();
  }

  return (
    <FormDialog
      title={rule ? t("settings.rules.editTitle") : t("settings.rules.create")}
      variant="wide"
      onClose={onClose}
      onSubmit={submit}
      formRef={form}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn" disabled={previewAction.busy} aria-busy={previewAction.busy} onClick={runPreview}>
            <Icon name="eye" size={18} /> {t("settings.rules.checkMatches")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.busy} aria-busy={save.busy}>
            {rule ? t("common.save") : t("settings.rules.create")}
          </button>
        </>
      }
    >
      {save.error && <Banner tone="danger">{save.error}</Banner>}
      {previewAction.error && <Banner tone="danger">{previewAction.error}</Banner>}
      <div className="form-grid">
        <Field label={t("settings.rules.patternLabel")} hint={t("settings.rules.patternHint")} error={errors.pattern}>
          {(control) => (
            <input
              {...control}
              value={pattern}
              maxLength={200}
              required
              onChange={(event) => {
                setPattern(event.target.value);
                setPreview(null);
                clear("pattern");
              }}
            />
          )}
        </Field>
        <Field label={t("settings.rules.searchIn")}>
          {(control) => (
            <select
              {...control}
              value={field}
              onChange={(event) => {
                setField(event.target.value as RuleField);
                setPreview(null);
              }}
            >
              {RULE_FIELDS.map((value) => (
                <option key={value} value={value}>
                  {t(`labels.ruleField.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("settings.rules.direction")} hint={t("settings.rules.directionHint")}>
          {(control) => (
            <select
              {...control}
              value={direction}
              onChange={(event) => {
                setDirection(event.target.value as RuleDirection);
                setPreview(null);
              }}
            >
              {RULE_DIRECTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`labels.ruleDirection.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("common.fields.category")} error={errors.target}>
          {(control) => (
            <select
              {...control}
              value={categoryId}
              onChange={(event) => {
                setCategoryId(event.target.value);
                clear("target");
              }}
            >
              <option value="">{t("common.none")}</option>
              {CATEGORY_KINDS.map((kind) => (
                <optgroup key={kind} label={t(`labels.categoryKind.${kind}`)}>
                  {categories
                    .filter((c) => c.kind === kind)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          )}
        </Field>
        <Field label={t("settings.rules.priority")} hint={t("settings.rules.priorityHint")} error={errors.priority}>
          {(control) => (
            <input
              {...control}
              type="number"
              inputMode="numeric"
              min={0}
              max={1000}
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value);
                clear("priority");
              }}
            />
          )}
        </Field>
      </div>
      <fieldset className="field">
        <legend>{t("common.fields.tags")}</legend>
        {tags.length === 0 ? (
          <p className="field-hint">{t("settings.rules.noTagsYet")}</p>
        ) : (
          <div className="chips">
            {tags.map((tag) => (
              <label key={tag.id} className="chip">
                <input
                  type="checkbox"
                  checked={tagIds.includes(tag.id)}
                  onChange={(event) => {
                    setTagIds(event.target.checked ? [...tagIds, tag.id] : tagIds.filter((id) => id !== tag.id));
                    clear("target");
                  }}
                />
                <span className="swatch" style={{ background: tag.color }} aria-hidden="true" />
                {tag.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      {preview && (
        <Banner tone="info">
          <strong>{t("settings.rules.matches", { count: preview.matchCount })}</strong>
          {preview.examples.length > 0 && <span>{t("settings.rules.examples", { examples: preview.examples.join(" · ") })}</span>}
        </Banner>
      )}
    </FormDialog>
  );
}
