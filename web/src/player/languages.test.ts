import { describe, expect, it } from "vitest";
import languageList from "../../../contracts/languages.json";
import { languageOption, SUPPORTED_LANGUAGES } from "./languages";

describe("the subtitle language list (decision 0035)", () => {
  it("is the one list in contracts/languages.json, which the agents generate theirs from", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(languageList.languages.map((l) => l.tag));
    expect(new Set(SUPPORTED_LANGUAGES).size).toBe(SUPPORTED_LANGUAGES.length);
  });

  it("offers every listed language with a name to search by", () => {
    for (const tag of SUPPORTED_LANGUAGES) {
      const option = languageOption(tag, "en");
      expect(option.tag).toBe(tag);
      expect(option.local.length).toBeGreaterThan(0);
    }
  });
});
