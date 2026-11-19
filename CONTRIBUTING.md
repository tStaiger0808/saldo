# Mitarbeiten an Saldo

Danke, dass du mithelfen willst! Diese Seite beschreibt, wie Beiträge ablaufen. Die technischen Konventionen (Aufbau,
Rollen, Zugriffsregeln, Sprache, Barrierefreiheit) stehen in [`AGENTS.md`](AGENTS.md) – sie gelten für Menschen und
Coding-Agents gleichermaßen.

## Grundsätze

- **Nur lesend.** Saldo löst niemals Zahlungen aus. Beiträge, die Zahlungen, Überweisungen oder Aufträge an Banken
  ermöglichen, werden nicht angenommen.
- **Keine echten Daten.** Keine echten IBANs, Namen, Zugangsdaten, Schlüssel, Tokens oder Kontoauszüge in Code, Tests,
  Screenshots, Issues oder Pull Requests. Für Tests gibt es die Demodaten (`apps/web/src/server/modules/seed/demo.ts`)
  und die Fake-Server unter `apps/web/e2e/`.
- **Eigener Code.** Keinen Code aus anderen Projekten kopieren.
- **Sicherheitslücken** bitte nicht als öffentliches Issue melden, sondern direkt und vertraulich an den Inhaber des
  Repositorys.

## Ablauf

1. **Issue zuerst** bei größeren Änderungen: kurz beschreiben, was und warum – dann lässt sich die Richtung abstimmen,
   bevor Arbeit anfällt.
2. **Eigener Branch** (oder Fork) von `main`, z. B. `feature/vertraege-export` oder `fix/buchungen-filter`. Auf `main`
   wird nie direkt gepusht.
3. **Pull Request gegen `main`**, klein und fokussiert, mit einer kurzen Beschreibung: was ändert sich, warum, wie
   getestet, bei Oberflächenänderungen gern mit Screenshot (Beispieldaten).
4. **Review**: Der Inhaber prüft und merged. Änderungswünsche bitte als weitere Commits im selben Branch umsetzen;
   bereits gepushte Commits nicht umschreiben (kein Force-Push).

## Entwicklungsumgebung

Voraussetzungen: [Bun](https://bun.sh) 1.4, Docker (für die Test-Datenbank).

```sh
bun install
docker run -d --name fw-test-db -e POSTGRES_USER=finanzen -e POSTGRES_PASSWORD=finanzen-test \
  -e POSTGRES_DB=finanzen_test -p 127.0.0.1:54329:5432 postgres:17-alpine
bun run dev
```

Mehr dazu im Abschnitt „Entwicklung“ der [`README.md`](README.md).

## Vor jedem Pull Request

Alle Prüfungen müssen grün sein:

```sh
bun run lint        # Biome, Warnungen zählen als Fehler
bun run typecheck
bun run test        # Unit- und Datenbanktests gegen die Test-Datenbank
bun run build
bun run e2e         # Playwright inkl. axe-Barrierefreiheitsprüfung
```

Dazu gehört:

- **Tests** für neues Verhalten: Logik in `packages/core` und `server/modules` mit Vitest, sichtbares Verhalten mit
  Playwright. Echte Banken oder KI-Anbieter werden in Tests nie aufgerufen.
- **Texte in allen vier Sprachen** (`apps/web/src/i18n/de.ts` ist die Quelle, `en`, `fr`, `it` müssen nachziehen).
- **Barrierefreiheit nach WCAG 2.1 AA** in allen Farbthemen, hell und dunkel; neue Farben laufen durch
  `bun apps/web/scripts/contrast.ts`.
- **Datenbankänderungen** nur über `bun run db:generate --name <name>` (keine handgeschriebenen oder geänderten
  Migrationen), und nur additiv.
- **Server-Funktionen per GET** ändern niemals Daten.

## Commits

- Englisch, kurze Betreffzeile im Imperativ (z. B. „Add CSV export for contracts“), Text nur wenn nötig.
- Keine automatisch erzeugten Zusatzzeilen wie „Co-Authored-By“ oder „Generated with …“.

## Lizenz

Saldo steht unter der [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-or-later). Mit einem Pull Request
stellst du deinen Beitrag unter dieselbe Lizenz und bestätigst, dass du ihn so einreichen darfst (eigene Arbeit oder
mit einer verträglichen Lizenz).
