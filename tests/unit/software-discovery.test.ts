import { describe, expect, it } from "vitest";
import {
  buildSoftwareDiscoverySuggestionRequest,
  parseSoftwareDiscoverySpreadsheetUpload,
  parseSoftwareDiscoveryInput,
  signalSourceText,
  type SavedSoftwareDiscoverySignal,
} from "@/lib/software-discovery";

describe("parseSoftwareDiscoveryInput", () => {
  it("requires a known source, source name and at least one signal", () => {
    expect(() => parseSoftwareDiscoveryInput({ source: "bank", sourceName: "Xero" })).toThrow(
      "Unknown software discovery source"
    );
    expect(() =>
      parseSoftwareDiscoveryInput({ source: "accounting_payment", signals: [{}] })
    ).toThrow("Source name is required");
    expect(() =>
      parseSoftwareDiscoveryInput({ source: "accounting_payment", sourceName: "Xero" })
    ).toThrow("At least one software signal is required");
  });

  it("parses accounting subscription/payment signals", () => {
    const parsed = parseSoftwareDiscoveryInput({
      source: "accounting_subscription",
      sourceName: "Xero",
      signals: [
        {
          externalRef: "txn-123",
          softwareName: "Notion",
          vendorName: "Notion Labs",
          transactionDescription: "NOTION.SO monthly workspace subscription",
          amount: "24.5",
          currency: "GBP",
          occurredOn: "2026-09-12",
        },
      ],
    });

    expect(parsed).toEqual([
      {
        source: "accounting_subscription",
        sourceName: "Xero",
        externalRef: "txn-123",
        softwareName: "Notion",
        vendorName: "Notion Labs",
        signalText: "NOTION.SO monthly workspace subscription",
        amount: 24.5,
        currency: "GBP",
        occurredOn: "2026-09-12",
      },
    ]);
  });

  it("parses SSO application signals", () => {
    const parsed = parseSoftwareDiscoveryInput({
      source: "sso_application",
      sourceName: "Okta",
      signals: [
        {
          externalRef: "app-456",
          softwareName: "Greenhouse",
          appLabel: "Greenhouse Recruiting",
        },
      ],
    });

    expect(parsed[0]).toMatchObject({
      source: "sso_application",
      sourceName: "Okta",
      softwareName: "Greenhouse",
      signalText: "Greenhouse Recruiting",
    });
  });

  it("validates dates and numbers before they reach Postgres", () => {
    expect(() =>
      parseSoftwareDiscoveryInput({
        source: "accounting_payment",
        sourceName: "QuickBooks",
        signals: [{ softwareName: "Slack", signalText: "SLACK", occurredOn: "12/09/2026" }],
      })
    ).toThrow("occurredOn must be YYYY-MM-DD");

    expect(() =>
      parseSoftwareDiscoveryInput({
        source: "accounting_payment",
        sourceName: "QuickBooks",
        signals: [{ softwareName: "Slack", signalText: "SLACK", amount: "free" }],
      })
    ).toThrow("amount must be a number");
  });
});

describe("parseSoftwareDiscoverySpreadsheetUpload", () => {
  it("parses accounting CSV exports using familiar column names", async () => {
    const formData = new FormData();
    formData.set("source", "accounting_subscription");
    formData.set("sourceName", "Xero");
    formData.set(
      "file",
      new File(
        [[
          "Software Name,Transaction Description,Amount,Currency,Date,Reference",
          ['Notion', '"NOTION.SO, monthly workspace subscription"', "24.5", "GBP", "2026-09-12", "txn-123"].join(","),
        ].join("\n")],
        "xero-export.csv",
        { type: "text/csv" }
      )
    );

    await expect(parseSoftwareDiscoverySpreadsheetUpload(formData)).resolves.toEqual([
      {
        source: "accounting_subscription",
        sourceName: "Xero",
        externalRef: "txn-123",
        softwareName: "Notion",
        vendorName: null,
        signalText: "NOTION.SO, monthly workspace subscription",
        amount: 24.5,
        currency: "GBP",
        occurredOn: "2026-09-12",
      },
    ]);
  });

  it("parses SSO TSV exports and rejects native spreadsheet files", async () => {
    const formData = new FormData();
    formData.set("source", "sso_application");
    formData.set("sourceName", "Okta");
    formData.set(
      "file",
      new File(["Application\tApp Label\tApp ID\nGreenhouse\tGreenhouse Recruiting\tapp-456"], "okta.tsv")
    );

    const parsed = await parseSoftwareDiscoverySpreadsheetUpload(formData);
    expect(parsed[0]).toMatchObject({
      source: "sso_application",
      sourceName: "Okta",
      externalRef: "app-456",
      softwareName: "Greenhouse",
      signalText: "Greenhouse Recruiting",
    });

    const rejected = new FormData();
    rejected.set("source", "sso_application");
    rejected.set("sourceName", "Okta");
    rejected.set("file", new File(["not parsed"], "okta.xlsx"));

    await expect(parseSoftwareDiscoverySpreadsheetUpload(rejected)).rejects.toThrow(
      "Export file must be CSV or TSV"
    );
  });
});

describe("buildSoftwareDiscoverySuggestionRequest", () => {
  const signal: SavedSoftwareDiscoverySignal = {
    id: "11111111-1111-4111-8111-111111111111",
    source: "accounting_payment",
    sourceName: "Xero",
    externalRef: "txn-123",
    softwareName: "Slack",
    vendorName: "Slack Technologies",
    signalText: "SLACK monthly team subscription",
    amount: 80,
    currency: "GBP",
    occurredOn: "2026-09-12",
  };

  it("builds a review suggestion linked to the discovery signal", () => {
    const request = buildSoftwareDiscoverySuggestionRequest(signal);

    expect(request).toMatchObject({
      kind: "register_intake",
      titleHint: "Slack software discovery review",
      sourceLabel: "Xero accounting payment signal",
      softwareDiscoverySignalId: signal.id,
    });
    expect(request.sourceText).toContain("SLACK monthly team subscription");
    expect(request.instruction).toContain("likely to process personal data");
  });

  it("keeps source details in the text the model must cite", () => {
    const sourceText = signalSourceText(signal);
    expect(sourceText).toContain("Source: Xero");
    expect(sourceText).toContain("Amount: 80 GBP");
    expect(sourceText).toContain("External reference: txn-123");
  });
});

describe("the per-request signal cap", () => {
  const signal = {
    softwareName: "Notion",
    transactionDescription: "NOTION.SO monthly workspace subscription",
  };

  // Each accepted signal costs one model call and two inserts, run in sequence
  // inside one request. Without a row cap a 2 MB export is tens of thousands of
  // them: the request dies partway through, having already written rows and
  // spent on every model call it managed to make.
  it("refuses more signals than one request can finish", () => {
    expect(() =>
      parseSoftwareDiscoveryInput({
        source: "accounting_subscription",
        sourceName: "Xero",
        signals: Array.from({ length: 101 }, () => signal),
      })
    ).toThrow("Too many software signals");
  });

  it("accepts a request that sits on the cap", () => {
    expect(
      parseSoftwareDiscoveryInput({
        source: "accounting_subscription",
        sourceName: "Xero",
        signals: Array.from({ length: 100 }, () => signal),
      })
    ).toHaveLength(100);
  });

  it("applies the same cap to a spreadsheet upload, which is the path that can exceed it", async () => {
    const header = "softwareName,transactionDescription\n";
    const rows = Array.from({ length: 101 }, (_, i) => `App ${i},Monthly subscription ${i}`).join("\n");
    const form = new FormData();
    form.set("source", "accounting_subscription");
    form.set("sourceName", "Xero");
    form.set("file", new File([header + rows], "export.csv", { type: "text/csv" }));

    await expect(parseSoftwareDiscoverySpreadsheetUpload(form)).rejects.toThrow(
      "Too many software signals"
    );
  });
});
