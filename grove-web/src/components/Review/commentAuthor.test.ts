import { expect, it } from "vitest";
import { commentAuthor } from "./commentAuthor";

it("takes the role off an author", () => {
  expect(commentAuthor("Codex (Reviewer)")).toEqual({ agent: "Codex", role: "Reviewer" });
  expect(commentAuthor("Garrick Zhang")).toEqual({ agent: "Garrick Zhang", role: "" });
  expect(commentAuthor("(x)")).toEqual({ agent: "(x)", role: "" });
});
