# Product feedback

Prepared September 13, 2026, for the existing Landmark project. Each entry uses the five requested fields. The reuse answers are evidence-based engineering recommendations for the entrant to review, not invented quotations or personal feelings. No onboarding duration is claimed.

Amazon/AWS-specific feedback comes first. No Amazon/AWS service was called at runtime. IAM/STS/CodeArtifact/CodeCommit/CDK were documentation references, not integrations. Bedrock, AgentCore, Strands, Kiro, SageMaker, Lambda, API Gateway, S3, Ring, Bee and Fire TV were not used in the submitted implementation; there is no product-use feedback to fabricate for them. AWS hosting mentioned as a possibility is not AWS usage. Transitive dependencies and type-only packages are covered with their parent tool; no direct product experience is claimed for every transitive package.

Evidence: [ledger](FRICTION-EVIDENCE.md), [friction log](FRICTION-LOG.md), [internal application cases](INTERNAL-FRICTION.md).

## PF01 — Alexa+ MCP Toolkit, CLI and onboarding documentation — docs only

**What it was used for.** Read integration and setup guidance for an Alexa+ track MCP submission. The private SDK/CLI, Local Inspector and simulator were not installed or exercised.

**What worked well.** The overview provides a useful separation between our MCP server and the Alexa-side add-on. It explicitly names 2025-11-25 support. [Overview](https://www.developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html).

**What needs work.** FL01–FL03 document revision mismatch, access prerequisites and inconsistent scope guidance. Runtime reliability and voice behavior cannot be rated from documentation.

**How onboarding felt.** We reached a working independent MCP endpoint, but did not reach an Alexa hello world. The setup assumes prior Solutions Architect coordination; Windows and this account’s onboarding remain unverified.

**Would build with it again.** Conditional yes for a future authorized integration. The current submission uses independent MCP; this is an engineering recommendation, not a claim that the developer has already completed Alexa onboarding.

## PF02 — AWS IAM, STS, CodeArtifact, CodeCommit and CDK setup references — docs only

**What it was used for.** Read the prerequisites and registry flow in the Alexa environment setup guide. No AWS CLI command, role assumption, IAM change, CodeArtifact login, CodeCommit checkout or CDK deployment was performed.

**What worked well.** The guide identifies the tools involved, making the private-registry dependency visible. [Environment setup](https://www.developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment.html).

**What needs work.** Explain the prior authorization step before giving credential and registry instructions, and mark which steps apply to MCP versus Category Action add-ons. We have no service behavior or billing complaint to report.

**How onboarding felt.** Documentation walkthrough only; account onboarding, permissions and first deployment were not tested.

**Would build with it again.** No current adoption decision: these services were not used to run Landmark. Reassess if the project obtains authorized toolkit access or chooses AWS hosting. Do not select AWS Builder on this basis.

## PF03 — MCP specification 2025-11-25

**What it was used for.** Define initialization, tool discovery/calls, Streamable HTTP and structured tool results for the real server and demo client.

**What worked well.** The local client negotiated 2025-11-25 and called eight tools. Structured output lets the client use a dedicated spoken field rather than extract data from narration.

**What needs work.** Our hand-written client mishandles valid SSE priming events (A5 F16); this is our implementation defect. A small versioned client conformance fixture would help catch it.

**How onboarding felt.** Executable wire assertions made progress assessable. We used versioned references rather than assuming every latest example belongs to the same revision.

**Would build with it again.** Yes, for explicit tool contracts and interoperability, after fixing our client and Origin-validation gaps. Local happy-path success does not establish full conformance.

## PF04 — @modelcontextprotocol/sdk 1.30.0

**What it was used for.** McpServer, WebStandardStreamableHTTPServerTransport and tool/resource registration in Landmark; official client transport in verification.

**What worked well.** Existing dependencies supported real local HTTP calls and JSON responses. The A7 probe accepts both Zod raw shapes and z.object(), and rejects plain JSON Schema with a useful diagnostic.

**What needs work.** FL04 describes the response-lifetime pitfall. FL05 requests a schema-porting example, not a diagnostic that already exists.

**How onboarding felt.** No trustworthy elapsed-time record exists. We could exercise the installed version locally without reinstalling it; a fresh installation was not tested.

**Would build with it again.** Yes, with a pinned compatible version, correct transport lifetime and real client-level checks.

## PF05 — Zod 3.25.76

**What it was used for.** Describe and validate the inputs of the eight MCP tools.

**What worked well.** Valid inputs reached the handlers; both supported registration forms passed the isolated A7 call probe.

**What needs work.** Our descriptions and schemas must agree: table_rows promises cursor handling that its schema does not support (A5 F10). Zod is not responsible for that inconsistency.

**How onboarding felt.** Used the already-installed package through the MCP SDK. No installation duration or migration experience is available.

**Would build with it again.** Yes. Keep its version compatible with the chosen SDK and check schema/description consistency.

## PF06 — ExcelJS 4.4.0

**What it was used for.** Read synthetic XLSX fixtures during offline ingestion and create test workbooks.

**What worked well.** The current version exposes merge spans and cell master relationships. Round-tripping the A7 merged workbook retained values and the A1 master.

**What needs work.** Our adapter needs separate provenance (FL06). We cannot substantiate the old assertion about different model shapes across unspecified versions.

**How onboarding felt.** Existing fixtures and ingest tests supported local verification; there is no measured fresh-install onboarding time.

**Would build with it again.** Yes for bounded XLSX ingestion, with fixtures for merged headers, hidden sheets and unsupported content. Review dependencies separately from functional behavior.

## PF07 — PapaParse 5.7.0 and @types/papaparse 5.3.15

**What it was used for.** Parse CSV and TSV files in the offline ingest path (`src/ingest/read.ts`).

**What worked well.** The parser supplies rows used by the local inference pipeline. The all-text review case reached inference; its dropped rows were caused by our header heuristic, not the parser.

**What needs work.** No reproducible PapaParse defect was established. Our adapter should preserve parse warnings and make delimiter/header choices visible.

**How onboarding felt.** Read and exercised through the existing project setup, not a new install. No elapsed-time or large-file benchmark was recorded.

**Would build with it again.** Yes for this bounded offline use; retain parse-error tests and avoid attributing downstream inference bugs to the parser.

## PF08 — Node.js 23.11.0

**What it was used for.** Run local HTTP hosting, TypeScript strip-only scripts, ingestion, tests and review probes.

**What worked well.** The existing local server and client exchanged real MCP messages. Node’s error identifies unsupported parameter properties precisely.

**What needs work.** Our runtime/compiler versions do not support the same syntax assumptions (FL07). EOL and deployment-runtime decisions are documented in A3; A7 does not claim a Node 24 run.

**How onboarding felt.** Used an installed runtime on Windows. Runtime setup time and behavior on other operating systems were not measured.

**Would build with it again.** Yes to Node, with a supported deployment release and a verified build/run path. Do not interpret this as recommending continued production use of Node 23.

## PF09 — TypeScript 5.7.2 and @types/node 22.10.2

**What it was used for.** Strict static checking and JavaScript output; Node type declarations for application code.

**What worked well.** Saved A5 results show typecheck/build passed. This helped check contracts but did not validate the user workflows.

**What needs work.** The installed compiler lacks erasableSyntaxOnly; emitted paths also disagree with our package start path (A5 F17). The path error belongs to project configuration.

**How onboarding felt.** Existing compiler setup worked for build/typecheck. No clean installation or version upgrade was attempted.

**Would build with it again.** Yes, after aligning runtime types, output paths and supported syntax. Add behavior checks where types cannot prove correctness.

## PF10 — Browser Web Speech APIs

**What it was used for.** The custom browser UI uses SpeechRecognition/webkitSpeechRecognition and speechSynthesis to route utterances to MCP and read results.

**What worked well.** The original routing/client code was exercised with typed inputs and real local HTTP. This proves the MCP path, not microphone recognition or audible delivery.

**What needs work.** Pending clarification, speech completion and runtime recognition-error fallback are application gaps. No live browser STT/TTS quality, network reliability or latency can be rated yet.

**How onboarding felt.** API wiring is present; real microphone permission and speech onboarding remain untested.

**Would build with it again.** Conditional yes for a prototype, subject to an actual browser rehearsal and accessible typed recovery. Do not claim successful hands-free use from code inspection.

## PF11 — Cloudflare Workers, KV, Wrangler 4.130.0 and Miniflare dependencies

**What it was used for.** Prepared Worker entry point and KV adapter. Wrangler is a development dependency; review called the original Worker module and used a deterministic KV double. No Cloudflare deployment or authenticated KV request is established.

**What worked well.** The Web Request/Response boundary allowed local module probes. Injectable storage made key collisions reproducible without user data.

**What needs work.** Missing asset routing, shared keys and volatile defaults are our defects (A5 F04–F06/F12). The saved audit also requires toolchain review. None of these prove a Cloudflare service outage.

**How onboarding felt.** Signup, card requirement, native emulator startup, first deploy, remote latency and billing are unverified.

**Would build with it again.** Conditional yes after a deployment trial and durable per-user storage fixes. There is not enough operational evidence for an unconditional reliability recommendation.

## PF12 — MCP Apps metadata and hand-written iframe bridge

**What it was used for.** Attempted an explain-result widget using core SDK metadata and an HTML resource. The extension package was not installed.

**What worked well.** The repository contains an HTML resource with semantic table markup. This is implementation presence, not proof of host interoperability.

**What needs work.** A5’s DOM/message double found no initialization handshake and no update from a standard tool-result notification. The custom bridge is incomplete; the old “worked first time” claim is withdrawn.

**How onboarding felt.** No supported live MCP Apps host was exercised. Package-compatibility assertions in old comments were not independently reproduced in A7.

**Would build with it again.** Conditional yes to the extension after using a compatible bridge and testing a real host; no to treating the current hand-written widget as finished.

## PF13 — npm and Git

**What it was used for.** npm scripts and saved dependency audit; Git for source/history. Versions and dependency behavior are preserved in local evidence rather than inferred from a clean README.

**What worked well.** The lockfile records resolved dependencies; Git identifies the source baseline and separates this documentation revision from application code.

**What needs work.** Our submission should distinguish a successful typecheck from a runnable package. npm start fails at the saved baseline; our scripts point to a missing file. No npm/Git bug is established.

**How onboarding felt.** Used existing installations; no fresh package install, repository publish or GitHub authentication flow was performed in A7.

**Would build with it again.** Yes, with working run instructions, reviewed lockfile changes and retained reproduction evidence.

## PF14 — Claude Code and Codex assistance

**What it was used for.** AI-assisted build notes/code and independent review, research, probes and submission drafting, as recorded in the project handoff/history.

**What worked well.** The review produced reproducible counterexamples and corrected unsupported claims in the earlier feedback.

**What needs work.** Generated prose overstated measured onboarding, SDK restrictions and widget success. Treat generated text as a draft requiring source and runtime checks, not incident evidence.

**How onboarding felt.** These tools were already available. Initial setup, comparative speed and paid usage cost were not measured for this project.

**Would build with it again.** Yes with human ownership and reproducible checks. This reflects the proposed development workflow; it is not a survey response from the principal.
