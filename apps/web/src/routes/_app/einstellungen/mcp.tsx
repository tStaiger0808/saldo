import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, Fragment, type ReactNode, useId, useState } from "react";
import { CopyButton } from "../../../components/Bits.tsx";
import { ConfirmDialog } from "../../../components/Dialog.tsx";
import { Field } from "../../../components/Field.tsx";
import { Banner, NoticeBanner } from "../../../components/Status.tsx";
import { useI18n, useT } from "../../../i18n/react.tsx";
import { useAction, useNotice } from "../../../lib/action.ts";
import { useFormErrors } from "../../../lib/forms.ts";
import { createMcpTokenFn, getMcpInfo, getMcpTokens, revokeMcpTokenFn } from "../../../server/functions/mcp.ts";

export const Route = createFileRoute("/_app/einstellungen/mcp")({
  loader: async () => {
    const [info, tokens] = await Promise.all([getMcpInfo(), getMcpTokens()]);
    return { info, tokens };
  },
  component: McpSection,
});

type Token = Awaited<ReturnType<typeof getMcpTokens>>[number];

const PLACEHOLDER = "<TOKEN>";

function claudeCode(url: string, token: string) {
  return `claude mcp add --transport http saldo ${url} --header "Authorization: Bearer ${token}"`;
}

function claudeDesktop(url: string, token: string, caPath: string) {
  return JSON.stringify(
    {
      mcpServers: {
        saldo: {
          command: "npx",
          args: ["mcp-remote", url, "--header", `Authorization: Bearer ${token}`],
          env: { NODE_EXTRA_CA_CERTS: caPath },
        },
      },
    },
    null,
    2,
  );
}

/** Places elements into a translated sentence at its `{name}` placeholders. */
function withParts(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/\{(\w+)\}/).map((piece, index) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence never reorder
    index % 2 === 1 ? <Fragment key={index}>{parts[piece] ?? piece}</Fragment> : piece,
  );
}

function Snippet({ title, code, children }: { title: string; code: string; children?: ReactNode }) {
  const id = useId();
  const t = useT();
  return (
    <section className="stack-sm" aria-labelledby={id}>
      <div className="row-between">
        <h3 id={id}>{title}</h3>
        <CopyButton text={code} label={t("settings.mcp.copyTitle", { title })} className="btn btn-sm" />
      </div>
      <pre className="code-block">{code}</pre>
      {children}
    </section>
  );
}

function McpSection() {
  const { info, tokens } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const { t, f } = useI18n();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<(Token & { token: string }) | null>(null);
  const [revoking, setRevoking] = useState<Token | null>(null);
  const { notice, setNotice, clear } = useNotice();
  const { form, errors, check, clear: clearError } = useFormErrors<{ name: string }>();
  const create = useAction(createMcpTokenFn);
  const revoke = useAction(revokeMcpTokenFn);
  const admin = user.role === "superuser";
  const token = created?.token ?? PLACEHOLDER;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!check({ name: name.trim() ? undefined : t("settings.mcp.nameRequired") })) return;
    const result = await create.run({ data: { name: name.trim() } });
    if (!result.ok) return;
    setCreated(result.value);
    setName("");
  }

  async function destroy(revoked: Token) {
    const result = await revoke.run({ data: { id: revoked.id } });
    if (created?.id === revoked.id) setCreated(null);
    setNotice(result.ok ? { tone: "ok", text: t("settings.mcp.revoked", { name: revoked.name }) } : { tone: "danger", text: result.error });
  }

  return (
    <>
      <NoticeBanner notice={notice} onClose={clear} />
      <section className="card" aria-labelledby="mcp-title">
        <h2 id="mcp-title">{t("settings.mcp.title")}</h2>
        <p className="muted measure">{t("settings.mcp.intro")}</p>
        <div className="field">
          <span className="field-label">{t("settings.mcp.address")}</span>
          <div className="copy-field">
            <code className="code-block" style={{ flex: 1 }}>
              {info.url}
            </code>
            <CopyButton text={info.url} label={t("settings.mcp.copyAddress")} />
          </div>
        </div>
      </section>
      <section className="card" aria-labelledby="tokens-title">
        <h2 id="tokens-title">{t("settings.mcp.tokens")}</h2>
        <form ref={form} className="row" style={{ alignItems: "flex-end" }} noValidate onSubmit={submit}>
          <Field label={t("settings.mcp.newTokenName")} error={errors.name} className="field-grow">
            {(control) => (
              <input
                {...control}
                value={name}
                maxLength={64}
                onChange={(event) => {
                  setName(event.target.value);
                  clearError("name");
                }}
              />
            )}
          </Field>
          <button type="submit" className="btn btn-primary" disabled={create.busy} aria-busy={create.busy}>
            {t("settings.mcp.createToken")}
          </button>
        </form>
        {create.error && <Banner tone="danger">{create.error}</Banner>}
        {created && (
          <div className="stack-sm">
            <strong>{t("settings.mcp.newToken", { name: created.name })}</strong>
            <Banner tone="warn">{t("settings.mcp.showOnce")}</Banner>
            <div className="token-box">
              <code>
                <span className="visually-hidden">{t("settings.mcp.tokenLabel")}</span>
                {created.token}
              </code>
              <CopyButton text={created.token} label={t("settings.mcp.copyToken")} />
            </div>
          </div>
        )}
        {tokens.length === 0 ? (
          <p className="empty">{t("settings.mcp.empty")}</p>
        ) : (
          <ul className="list">
            {tokens.map((item) => {
              const lastUse = item.lastUsedAt
                ? t("settings.mcp.lastUsed", { date: f.dateTime(item.lastUsedAt) })
                : t("settings.mcp.neverUsed");
              const used = item.expiresAt
                ? `${lastUse} · ${t("settings.mcp.expires", { date: f.date(item.expiresAt.slice(0, 10)) })}`
                : lastUse;
              const createdAt = f.dateTime(item.createdAt);
              return (
                <li key={item.id}>
                  <span className="list-main">
                    <span className="list-title">
                      {item.name} <code className="muted">{item.prefix}…</code>
                    </span>
                    <span className="list-sub">
                      {admin && item.userId !== user.id
                        ? t("settings.mcp.metaBy", { user: item.username ?? "?", created: createdAt, used })
                        : t("settings.mcp.meta", { created: createdAt, used })}
                    </span>
                  </span>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => setRevoking(item)}>
                    {t("settings.mcp.revoke")}
                    <span className="visually-hidden">: {item.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="card" aria-labelledby="snippets-title">
        <h2 id="snippets-title">{t("settings.mcp.setupTitle")}</h2>
        <p className="muted">
          {created ? t("settings.mcp.setupWithToken") : t("settings.mcp.setupPlaceholder", { placeholder: PLACEHOLDER })}
        </p>
        <Snippet title="Claude Code" code={claudeCode(info.url, token)}>
          <p className="muted small">{t("settings.mcp.claudeCodeHint")}</p>
        </Snippet>
        <Snippet title="Claude Desktop" code={claudeDesktop(info.url, token, t("settings.mcp.caPath"))}>
          <p className="muted small">
            {withParts(t("settings.mcp.desktopHint", { file: "{file}" }), { file: <code>claude_desktop_config.json</code> })}{" "}
            <strong>{t("settings.mcp.certTitle")}</strong>{" "}
            {withParts(t("settings.mcp.certText", { env: "{env}", tool: "{tool}" }), {
              env: <code>NODE_EXTRA_CA_CERTS</code>,
              tool: <code>mcp-remote</code>,
            })}
          </p>
        </Snippet>
      </section>
      <section className="card" aria-labelledby="tools-title">
        <h2 id="tools-title">{t("settings.mcp.toolsTitle")}</h2>
        <p className="muted">{t("settings.mcp.toolsIntro")}</p>
        <ul className="list">
          {info.tools.map((tool) => (
            <li key={tool.name}>
              <span className="list-main">
                <code>{tool.name}</code>
                <span className="list-sub">{tool.description}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      <ConfirmDialog
        open={revoking !== null}
        title={t("settings.mcp.revokeTitle", { name: revoking?.name ?? "" })}
        confirmLabel={t("settings.mcp.revokeConfirm")}
        danger
        onConfirm={() => revoking && destroy(revoking)}
        onClose={() => setRevoking(null)}
      >
        <p>{t("settings.mcp.revokeText")}</p>
      </ConfirmDialog>
    </>
  );
}
