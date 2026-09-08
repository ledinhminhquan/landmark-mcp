# Security notes

## Dependency audit — `npm audit` reports 2 moderate, both accepted with reasoning

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

## Supply-chain posture

`sfw` (Socket Firewall) wraps installs in this project. Rationale: the DPRK *Contagious
Interview* cluster targets exactly this developer profile, and its documented delivery vector is
`npm install` on a repository sent by a "recruiter". Installing is executing — a `postinstall`
script needs no file to be opened.

House rules for this repo:

- Dependencies are **pinned to exact versions**, not ranges. Four runtime dependencies, all
  widely used, all with a maintenance history.
- No third-party repository is built or run outside a disposable VM.
- `package.json` scripts are readable in full and contain no network calls.
