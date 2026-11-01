import { expect, it } from "vitest";
import { buildGroveMetaTag } from "../../../utils/groveMeta";
import { buddyMessageSender, renderGroveMetaEnvelope } from "./groveMetaRenderers";

it("reads the sending Buddy from its envelope and renders nothing in the bubble", () => {
  const tag = buildGroveMetaTag("buddy_message", { buddy_id: "b1", name: "Jack", avatar: "ghost" }, "From Buddy Jack");
  expect(buddyMessageSender(`${tag}\n## Background`)).toEqual({ id: "b1", name: "Jack", avatar: "ghost" });
  expect(buddyMessageSender(buildGroveMetaTag("buddy_message", {}, ""))).toEqual({ id: "", name: "Buddy", avatar: null });
  expect(buddyMessageSender("plain text")).toBeNull();
  expect(renderGroveMetaEnvelope({ v: 1, type: "buddy_message", data: { name: "Jack" }, systemPrompt: "" }, { layout: "block" })).toBeNull();
});
