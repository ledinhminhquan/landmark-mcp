# Optional feature requests

Updated September 27, 2026. Each request comes from an entry in the
[friction log](FRICTION-LOG.md) or from [product feedback](PRODUCT-FEEDBACK.md). Priorities
reflect what this project needed, not how severe a vendor's own incident would be; nothing is
marked Critical to chase a bonus. None of these requests has been sent to any team.

| # / owner | Request, and why it matters | Priority | How to tell it is done |
|---|---|---|---|
| 1 / Amazon Alexa+ docs | Say which fields of a tool result Alexa's voice uses, and whether a ready-made sentence can be spoken as written. The Functional Requirements hold the add-on to spoken length and wording, while the design guide says the add-on cannot script the reply. Friction log 4. | Important, above all for voice-first and accessibility add-ons | One page states how a tool result becomes speech, and the "The add-on responds" examples agree with it. |
| 2 / Amazon Alexa+ docs | Mark which accessibility checks can be run without a device, and say how an entrant without toolkit access should show accessibility. Friction log 5. | Important for accessibility entries | The accessibility test list separates device-only checks from the rest. |
| 3 / Amazon Alexa+ docs | Align the service-token scope example with the scope table, and add a test showing a service token cannot reach user data. Friction log 3. | Important before any private-data integration | One consistent `client_credentials` example and a negative test. |
| 4 / Amazon Alexa+ docs | Label each lifecycle example with its protocol revision and add a 2025-11-25 pair. Friction log 1. | Important | The worked initialize exchange matches the supported revision, or older examples say what they are for. |
| 5 / Amazon onboarding | Put the partner-only notice and the way to request access at the top of the overview and every setup page, and point others to the public MCP route. Friction log 2. | Important | A reader knows whether the private toolkit applies to them before touching AWS or npm settings. |
| 6 / MCP TypeScript SDK | A public way to shape the result of input-validation and unknown-tool errors, so it can carry `structuredContent` like any other tool error. Friction log 7. | Important | A server returns its own error shape for a refused argument without replacing a private method. |
| 7 / MCP TypeScript SDK docs | A per-request Web `Response` example with a delayed tool, showing when closing the transport is safe, plus the JSON-response alternative. Friction log 6. | Important | Both the SSE and JSON variants deliver the result in the entry 6 probe. |
| 8 / npm | Pass a bare `--` through `npm.ps1` to npm, or document that PowerShell users must quote it; and say in the warning that the flag did not reach the script. Friction log 10. | Important: the failure can overwrite a file without an error | `npm run show -- a --out b` in PowerShell passes all three arguments to the script. |
| 9 / MCP TypeScript SDK docs | In the stateless-server example, mention that each server builds its own JSON Schema validator unless one is shared through `jsonSchemaValidator`. Measured September 27 on Node 23.11 (four runs of 300 constructions): 0.10–0.16 ms per server with the default, 0.01 ms or less with a shared one. See product feedback. | Nice-to-have | The stateless example shares one validator. |
| 10 / MCP client testing ecosystem | Small offline fixtures for clients: an event stream with a keep-alive or notification before the reply, several messages, error replies. Our own page's client once failed the first of these. | Nice-to-have | A client passes the fixtures. Ours now passes its own version (`test/wire.test.ts`). |
| 11 / spreadsheet-library documentation | A recipe for keeping a cell's value together with its merge anchor and span through an import. Friction log 9. | Nice-to-have | A1:A3 keeps "Engineering" and master A1 after a round trip, and downstream rows keep their provenance. |
| 12 / Alexa+ developer testing | A public, versioned conformance fixture for tool discovery, tool results and MCP Apps messages that needs no device or private access. | Nice-to-have | An entrant without toolkit access can check wire contracts locally, without claiming an Alexa deployment. |

These are requests and proposed acceptance checks. They are not claims that any of these exist
or that anyone has agreed to build them.
