import { describe, expect, it } from "vitest";
import { buildRules, findMatches, fold } from "../lib/redaction/rules";
import { EMPTY_CONTEXT, type ClientContext } from "../lib/redaction/types";

const ctx: ClientContext = {
  ...EMPTY_CONTEXT,
  fullName: "Juan Carlos García López",
  otherNames: ["Juanito Garcia"],
  dateOfBirth: "1990-03-14",
  aNumber: "A-012-345-678",
  street: "123 West 45th Street, Apt 4B",
  city: "Brooklyn",
  state: "NY",
  zip: "11201",
  extraTerms: ["(718) 555-0199"],
};
const rules = buildRules(ctx);
const found = (text: string) => findMatches(text, rules).filter((m) => m.defaultOn).map((m) => m.text);

describe("fold", () => {
  it("keeps length", () => {
    const s = "García LÓPEZ Ñandú";
    expect(fold(s).length).toBe(s.length);
    expect(fold(s)).toBe("garcia lopez nandu");
  });
});

describe("names", () => {
  it("finds the full name in several orders", () => {
    expect(found("Client: Juan Carlos García López.")).toEqual(["Juan Carlos García López"]);
    expect(found("GARCIA LOPEZ, JUAN CARLOS")).toEqual(["GARCIA LOPEZ, JUAN CARLOS"]);
    expect(found("Juan C. Garcia Lopez")).toEqual(["Juan C. Garcia Lopez"]);
    expect(found("Mr. Juan Garcia appeared")).toEqual(["Juan Garcia"]);
    expect(found("signed /s/ Juan Garcia")).toEqual(["/s/ Juan Garcia"]);
    expect(found("aka Juanito Garcia")).toEqual(["Juanito Garcia"]);
  });
  it("finds a lone surname on a form", () => {
    expect(found("Family Name (Last Name): GARCIA")).toEqual(["GARCIA"]);
  });
  it("leaves other people's names unselected", () => {
    const ms = findMatches("His sister Maria Garcia lives in Texas.", rules);
    expect(ms.map((m) => [m.text, m.defaultOn])).toEqual([["Garcia", false]]);
    expect(found("Pedro Martinez is the witness.")).toEqual([]);
  });
});

describe("dates of birth", () => {
  it("matches common formats", () => {
    for (const s of ["03/14/1990", "3/14/90", "14/03/1990", "1990-03-14", "March 14, 1990", "Mar. 14 1990", "14 de marzo de 1990", "14th of March, 1990", "03141990"]) {
      expect(found(`DOB: ${s}.`)).toEqual([s]);
    }
  });
  it("ignores other dates", () => {
    expect(found("Filed 03/14/2024 and 04/14/1990")).toEqual([]);
  });
});

describe("A-numbers", () => {
  it("matches formats with and without the A and leading zero", () => {
    for (const s of ["A012345678", "A-012-345-678", "A# 012 345 678", "012345678", "A12345678", "0 1 2 3 4 5 6 7 8"]) {
      expect(found(`Alien no: ${s} end`)).toEqual([s]);
    }
  });
  it("does not match another A-number or longer digit strings", () => {
    expect(found("A-987-654-321 and 1012345678")).toEqual([]);
  });
});

describe("addresses", () => {
  it("matches the street with abbreviations", () => {
    expect(found("lives at 123 W. 45th St., #4B")).toEqual(["123 W. 45th St., #4B"]);
    expect(found("123 West 45th Street")).toEqual(["123 West 45th Street"]);
    expect(found("Brooklyn, New York 11201")).toEqual(["Brooklyn, New York 11201"]);
    expect(found("Zip code 11201-1234")).toEqual(["11201-1234"]);
  });
  it("does not select a lone city by default", () => {
    expect(found("Kings County Court, Brooklyn")).toEqual([]);
  });
});

describe("extra terms", () => {
  it("matches phone numbers loosely", () => {
    expect(found("Tel 718-555-0199")).toEqual(["718-555-0199"]);
  });
});
