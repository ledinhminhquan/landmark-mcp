# Optional feature requests

September 13, 2026. Priorities reflect this project’s needs, not vendor incident severity. No request is marked Critical merely to seek a larger bonus. Requests have not been sent to any team.

| ID / owner | Request and why it matters | Urgency | Acceptance check / evidence |
|---|---|---|---|
| FR01 / Amazon Alexa+ docs | Align service-token scope examples and provide a deny-user-data test. This prevents an implementer copying contradictory authorization guidance. | Important; required before our future private-data integration | One consistent client_credentials example and a test that cannot access user data. FL03. |
| FR02 / Amazon Alexa+ docs | Add a version-labelled lifecycle example and maintain it with an executable protocol check. | Important | Published supported revision matches the worked initialization pair or explicitly labels older compatibility examples. FL01. |
| FR03 / Amazon onboarding | Put the access prerequisites and request path before credential setup; offer a public MCP path for entrants without private tooling. | Important | A reader can identify the applicable route before changing AWS/npm configuration. FL02. |
| FR04 / MCP TypeScript SDK docs | Add a Web Response lifetime example with a delayed tool, safe cleanup and the JSON alternative. | Important | Both SSE and JSON variants deliver the result in the FL04 probe. |
| FR05 / MCP client testing ecosystem | Publish tiny offline interoperability fixtures: priming SSE, multiple messages, initialized notification and error replies. Our custom client missed these cases. | Important | A client handles the saved A5 F16 priming-event case and correlates the response ID. This is not a claim that a vendor client failed. |
| FR06 / spreadsheet-adapter documentation | Show how to retain cell value plus merge anchor/span in a value-only export. | Nice-to-have | A1:A3 retains Engineering and master A1 after round-trip, and downstream rows keep provenance. FL06. |
| FR07 / Alexa+ developer testing | Provide a publicly accessible, versioned, non-device conformance fixture for tool discovery, tool results and Apps messages, separate from production onboarding. | Nice-to-have | A restricted-access entrant can verify wire contracts locally without claiming an Alexa deployment. Our live Alexa/MCP Apps behavior remains untested. |

These are concrete requests or proposed acceptance checks, not claims that the requested products exist or that Amazon has agreed to build them.
