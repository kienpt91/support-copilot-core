import { describe, expect, it } from "vitest";
import { findPii, ibanChecksumValid, luhn, redactStatic } from "../src/privacy/pii.js";
import { PiiVault } from "../src/privacy/vault.js";

// Test numbers are assembled at runtime so no card-like literal sits in the source.
const card = (...groups: string[]) => groups.join(" ");
const VISA = ["4111", "1111", "1111", "1111"];
const MC = ["5555", "5555", "5555", "4444"];

const kinds = (text: string) => findPii(text).map((m) => m.kind);
const values = (text: string) => findPii(text).map((m) => m.value);

describe("email detection", () => {
  it("finds plain, tagged, subdomain and upper-case addresses", () => {
    expect(values("write to jane.doe+billing@mail.example.co.uk now")).toEqual(["jane.doe+billing@mail.example.co.uk"]);
    expect(values("JANE@EXAMPLE.COM")).toEqual(["JANE@EXAMPLE.COM"]);
  });

  it("finds spelled-out obfuscations", () => {
    expect(kinds("jane [at] example [dot] com")).toEqual(["EMAIL"]);
    expect(kinds("jane(at)example(dot)com")).toEqual(["EMAIL"]);
  });

  it("sees through zero-width characters and covers them in the span", () => {
    const text = "mail ja\u200Bne@exam\u200Dple.com please";
    const [m] = findPii(text);
    expect(m?.kind).toBe("EMAIL");
    expect(m?.value).toBe("ja\u200Bne@exam\u200Dple.com");
    expect(redactStatic(text)).toBe("mail [EMAIL] please");
  });

  it("handles full-width at-sign and dots", () => {
    expect(kinds("jane＠example．com")).toEqual(["EMAIL"]);
  });

  it("does not flag text without a domain", () => {
    expect(kinds("meet @ noon, handle @jane, a@b")).toEqual([]);
  });
});

describe("phone detection", () => {
  it.each(["+1 (415) 555-2671", "415-555-2671", "+84 912 345 678", "(415) 555-2671", "+44 20 7946 0958", "415.555.2671", "555-1234"])(
    "finds %s",
    (phone) => {
      expect(kinds(`call me on ${phone} today`)).toEqual(["PHONE"]);
      expect(values(`call me on ${phone} today`)).toEqual([phone]);
    },
  );

  it("handles full-width digits and a full-width plus sign", () => {
    expect(kinds("ring ＋８４ ９１２ ３４５ ６７８ soon")).toEqual(["PHONE"]);
  });

  it("handles Arabic-Indic digits", () => {
    expect(kinds("tel ٠٤١٥٥٥٥٢٦٧١ ok")).toEqual(["PHONE"]);
  });

  it("does not flag dates, versions, IPs, prices or short order numbers", () => {
    for (const s of ["on 2024-01-15 we", "version 1.2.3.4", "host 192.168.1.1", "total 1234567.89", "order 1234567", "ticket 99887"]) {
      expect(kinds(s), s).toEqual([]);
    }
  });
});

describe("card detection", () => {
  it("finds Luhn-valid numbers with spaces, dashes, dots and no separators", () => {
    expect(kinds(`pay ${card(...VISA)}`)).toEqual(["CARD"]);
    expect(kinds(`pay ${VISA.join("-")}`)).toEqual(["CARD"]);
    expect(kinds(`pay ${MC.join(".")}`)).toEqual(["CARD"]);
    expect(kinds(`pay ${VISA.join("")}`)).toEqual(["CARD"]);
  });

  it("finds numbers split by non-breaking spaces or written in full-width digits", () => {
    expect(kinds(`pay ${VISA.join("\u00A0")}`)).toEqual(["CARD"]);
    const fullWidth = VISA.join("").replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
    expect(kinds(`pay ${fullWidth}`)).toEqual(["CARD"]);
  });

  it("ignores digit strings that fail the Luhn check", () => {
    const bad = [...VISA.slice(0, 3), "1112"].join(" ");
    expect(luhn(bad.replace(/ /g, ""))).toBe(false);
    expect(kinds(bad)).toEqual([]);
  });

  it("reports a card once, not also as a phone number", () => {
    expect(findPii(`card ${card(...VISA)}`)).toHaveLength(1);
  });

  it("luhn() rejects wrong lengths and non-digits", () => {
    expect(luhn("")).toBe(false);
    expect(luhn("4111-1111-1111-1111")).toBe(false);
    expect(luhn(VISA.join(""))).toBe(true);
  });
});

describe("IBAN detection", () => {
  it("finds grouped, compact and lower-case IBANs", () => {
    expect(kinds("iban DE89 3704 0044 0532 0130 00")).toEqual(["IBAN"]);
    expect(kinds("iban DE89370400440532013000")).toEqual(["IBAN"]);
    expect(kinds("iban gb82 west 1234 5698 7654 32")).toEqual(["IBAN"]);
  });

  it("stops at the end of the IBAN when words follow", () => {
    expect(values("send to DE89 3704 0044 0532 0130 00 please thanks")).toEqual(["DE89 3704 0044 0532 0130 00"]);
  });

  it("requires a valid mod-97 checksum", () => {
    expect(ibanChecksumValid("DE89370400440532013000")).toBe(true);
    expect(ibanChecksumValid("DE88370400440532013000")).toBe(false);
    expect(kinds("iban DE88 3704 0044 0532 0130 00")).toEqual([]);
  });
});

describe("national id detection", () => {
  it("finds formatted US social security numbers", () => {
    expect(kinds("ssn is 123-45-6789")).toEqual(["NATIONAL_ID"]);
    expect(kinds("123 45 6789")).toEqual(["NATIONAL_ID"]);
  });

  it("rejects impossible SSN areas", () => {
    expect(kinds("000-12-3456")).toEqual([]);
    expect(kinds("666-12-3456")).toEqual([]);
  });

  it("finds UK NINO and Vietnamese 12-digit citizen ids", () => {
    expect(kinds("nino AB 12 34 56 C")).toEqual(["NATIONAL_ID"]);
    expect(kinds("cccd 079201001234")).toEqual(["NATIONAL_ID"]);
    expect(kinds("id 079201001234 here")).toEqual(["NATIONAL_ID"]);
  });

  it("uses a keyword for unformatted passport and id numbers", () => {
    expect(values("my passport number: X1234567 expires")).toEqual(["X1234567"]);
    expect(kinds("reference X1234567")).toEqual([]);
  });
});

describe("overlaps and offsets", () => {
  it("returns non-overlapping spans in order with exact original offsets", () => {
    const text = `a jane@example.com b ${card(...MC)} c +1 415 555 2671 d`;
    const found = findPii(text);
    expect(found.map((m) => m.kind)).toEqual(["EMAIL", "CARD", "PHONE"]);
    for (const m of found) expect(text.slice(m.start, m.end)).toBe(m.value);
    for (let i = 1; i < found.length; i++) expect(found[i]!.start).toBeGreaterThanOrEqual(found[i - 1]!.end);
  });

  it("leaves text without PII untouched", () => {
    const text = "How do I reset my password? It was 12 minutes ago.";
    expect(findPii(text)).toEqual([]);
    expect(redactStatic(text)).toBe(text);
  });

  it("handles empty input", () => {
    expect(findPii("")).toEqual([]);
  });

  it("stays fast on long adversarial input", () => {
    const text = "1 ".repeat(20000) + "a".repeat(20000) + "@".repeat(5000);
    const start = Date.now();
    findPii(text);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("PiiVault", () => {
  const nonce = "ab12cd34";

  it("replaces values with placeholders and reuses one placeholder per value", () => {
    const vault = new PiiVault(nonce);
    const out = vault.redact("jane@example.com and again jane@example.com, also bob@example.com", "user");
    expect(out).toBe(`[EMAIL_1:${nonce}] and again [EMAIL_1:${nonce}], also [EMAIL_2:${nonce}]`);
    expect(vault.size).toBe(2);
  });

  it("never lets the real value appear in redacted text", () => {
    const vault = new PiiVault(nonce);
    const out = vault.redact(`mail jane@example.com card ${card(...VISA)} phone +1 415 555 2671`, "user");
    expect(out).not.toMatch(/example\.com|4111|555 2671/);
  });

  it("restores user-supplied values under the 'user' policy only", () => {
    const vault = new PiiVault(nonce);
    const fromUser = vault.redact("jane@example.com", "user");
    const fromDoc = vault.redact("help@acme.example", "evidence");
    expect(vault.restore(`${fromUser} / ${fromDoc}`, "user")).toBe("jane@example.com / [EMAIL]");
    expect(vault.restore(`${fromUser} / ${fromDoc}`, "all")).toBe("jane@example.com / help@acme.example");
    expect(vault.restore(`${fromUser} / ${fromDoc}`, "none")).toBe("[EMAIL] / [EMAIL]");
  });

  it("promotes a value to user-supplied when the user also typed it", () => {
    const vault = new PiiVault(nonce);
    const a = vault.redact("help@acme.example", "evidence");
    vault.redact("help@acme.example", "user");
    expect(vault.restore(a, "user")).toBe("help@acme.example");
  });

  it("never restores card numbers or national ids, even with policy 'all'", () => {
    const vault = new PiiVault(nonce);
    const text = vault.redact(`card ${card(...VISA)} ssn 123-45-6789 iban DE89 3704 0044 0532 0130 00`, "user");
    expect(vault.restore(text, "all")).toBe("card [CARD] ssn [NATIONAL_ID] iban DE89 3704 0044 0532 0130 00");
  });

  it("does not restore forged placeholders that carry another nonce", () => {
    const vault = new PiiVault(nonce);
    vault.redact("jane@example.com", "user");
    expect(vault.restore("[EMAIL_1:00000000]", "all")).toBe("[EMAIL_1:00000000]");
    expect(vault.restore("[EMAIL_9:" + nonce + "]", "all")).toBe("[EMAIL]");
  });

  it("falls back to static tags for every placeholder that is not restored", () => {
    const vault = new PiiVault(nonce);
    const text = vault.redact("jane@example.com", "user");
    expect(vault.restore(`Sent to ${text}.`, "none")).toBe("Sent to [EMAIL].");
  });
});

describe("separators and padding tricks", () => {
  it.each(["/", "_", "- ", ". "])("finds a card number separated by %j", (sep) => {
    expect(kinds(`pay ${VISA.join(sep)} now`)).toEqual(["CARD"]);
  });

  it("finds a card number padded with combining marks between the digits", () => {
    const padded = VISA.join("").split("").join("\u0301");
    const text = `pay ${padded} now`;
    expect(kinds(text)).toEqual(["CARD"]);
    expect(redactStatic(text)).toBe("pay [CARD] now");
  });

  it("still treats accented words as words, not as PII", () => {
    expect(kinds("caf\u00e9 cr\u00e8me \u0111\u01b0\u1eddng")).toEqual([]);
  });

  it("does not turn digit lists with other separators into cards", () => {
    expect(kinds("1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14")).toEqual([]);
    expect(kinds("2026-10-31 02:12:45")).toEqual([]);
  });
});

describe("overlap resolution", () => {
  it("prefers the higher-priority kind when candidates overlap and leaves neighbours alone", () => {
    const text = `a ${card(...VISA)} b 123-45-6789 c +1 415 555 2671 d ${card(...MC)} e`;
    expect(kinds(text)).toEqual(["CARD", "NATIONAL_ID", "PHONE", "CARD"]);
  });

  it("gives the same spans for a long input as for its pieces", () => {
    const piece = `mail jane@example.com or call +1 415 555 2671 re ${card(...VISA)}. `;
    const single = findPii(piece).map((m) => [m.kind, m.value]);
    const repeated = findPii(piece.repeat(200));
    expect(repeated).toHaveLength(single.length * 200);
    expect(repeated.slice(0, single.length).map((m) => [m.kind, m.value])).toEqual(single);
  });
});

describe("vault nonce", () => {
  it("is 24 random letters (about 113 bits) by default and differs between vaults", () => {
    const a = new PiiVault().redact("jane@example.com", "user");
    const b = new PiiVault().redact("jane@example.com", "user");
    expect(a).toMatch(/^\[EMAIL_1:[a-z]{24}\]$/);
    expect(b).toMatch(/^\[EMAIL_1:[a-z]{24}\]$/);
    expect(a).not.toBe(b);
  });

  it("never contains anything the detectors would re-redact, however many vaults are drawn", () => {
    const text = `jane@example.com +1 415 555 2671 ${card(...VISA)} DE89 3704 0044 0532 0130 00 123-45-6789`;
    for (let i = 0; i < 3000; i++) {
      const redacted = new PiiVault().redact(text, "user");
      expect(redactStatic(redacted)).toBe(redacted);
    }
  });
});
