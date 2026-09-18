# Security notes

*Audit state re-checked 2026-09-18. Re-run `npm audit` before believing this file: a
note that says "2 moderate" while the tool says "2 moderate, 3 high" is worse than no
note, because it reads as though someone looked.*

## Dependency audit — 2 moderate, accepted with reasoning

`npm audit` currently reports **2 moderate and no high**. It previously reported three
high-severity advisories that this file did not mention, all one root cause and all now
cleared rather than accepted; that is recorded below.

`npm audit` flags `uuid <11.1.1` reached through `exceljs@4.4.0`, and proposes "fixing" it by
downgrading to `exceljs@3.4.0` — a major version downgrade that would remove the merged-cell
model this project depends on. We did not take that advice, and we did not force `uuid` to a
major it was never tested against. We checked whether the vulnerable path is reachable instead.

**Advisory:** *Missing buffer bounds check in v3/v5/v6 when `buf` is provided.*

**Reachability analysis:**

```
$ grep -rn "uuid" node_modules/exceljs/lib/
lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js:1:  const {v4: uuidv4} = require('uuid');
lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js:43:   model.x14Id = `{${uuidv4()}}`.toUpperCase();
lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js:77:   id: model.x14Id || `{${uuidv4()}}`,
```

Three facts make the advisory inapplicable here:

1. ExcelJS calls **`v4`**. The advisory covers **v3, v5 and v6**.
2. Both call sites pass **no arguments**. The defect requires a caller-supplied `buf`.
3. The only file involved is the conditional-formatting *extension writer*. Landmark reads
   workbooks; it never writes them.

**Decision:** accepted, not suppressed. Re-check on every `exceljs` upgrade. If ExcelJS ever
moves to a `uuid` major, revisit — do not carry this note forward unverified.

## The three high-severity advisories this file used to omit — fixed, not accepted

`sharp` below 0.35.4 carries two libheif vulnerabilities (GHSA-rgj7-g3m4-5g8c). It is
reached through `miniflare`, which is reached through `wrangler`, and npm reports the
chain as three separate high entries. All three are the same defect in an image decoder.

Two things were true and only one of them was written down. The reachability argument is
strong — `wrangler` is a devDependency used to run and deploy the Worker, `sharp` never
enters the Worker bundle, and nothing in this project decodes an image. But that argument
was never made here, so the file simply read as if the highs did not exist.

They are gone rather than argued away: `wrangler` 4.134.0 resolves a patched `miniflare`.
Upgraded and pinned, `npm audit` reports 2 moderate and no high, `wrangler deploy
--dry-run` still validates the config, and all 100 tests pass. Prefer this outcome to a
reachability essay whenever a fix exists — the essay has to be re-verified on every
upgrade and the fix does not.

## Supply-chain posture

`sfw` (Socket Firewall) wraps installs in this project. Rationale: the DPRK *Contagious
Interview* cluster targets exactly this developer profile, and its documented delivery vector is
`npm install` on a repository sent by a "recruiter". Installing is executing — a `postinstall`
script needs no file to be opened.

House rules for this repo:

- Dependencies are **pinned to exact versions**, not ranges — including development
  ones. `wrangler` was carried as `^4.130.0`, which is a range, and a house rule with an
  exception nobody wrote down is not a house rule. Four runtime dependencies, all widely
  used, all with a maintenance history.
- No third-party repository is built or run outside a disposable VM.
- `package.json` scripts are readable in full and contain no network calls.
