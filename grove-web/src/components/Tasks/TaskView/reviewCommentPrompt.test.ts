import { describe, expect, it } from "vitest";
import { buildReviewCommentMessage, buildReviewCommentsMessage, isReviewCommentBatch } from "./reviewCommentPrompt";

const inline = { id: 7, file_path: "src/app/main.ts", start_line: 10, end_line: 12, content: "Rename this", agent: "claude", status: "open" };
const project = { id: 9, comment_type: "project", content: "Add tests", status: "outdated" };

function payload(tag: string) {
  const m = /^<grove-meta>(.*)<\/grove-meta>$/s.exec(tag);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]);
}

describe("review comment chat prompt", () => {
  it("keeps the single-comment message exactly as before", () => {
    expect(payload(buildReviewCommentMessage(inline))).toEqual({
      v: 1,
      type: "review_comment",
      data: { id: 7, commentType: "inline", filePath: "src/app/main.ts", startLine: 10, endLine: 12, content: "Rename this", agent: "claude", status: "open" },
      "system-prompt": 'Please address Code Review Comment #7 on main.ts:L10-L12. Comment: "Rename this". Use the grove_reply_review tool to reply and set resolve: true when addressed.',
    });
    expect(payload(buildReviewCommentMessage({ ...inline, end_line: 10 }))["system-prompt"]).toContain("on main.ts:L10.");
    expect(payload(buildReviewCommentMessage(project))["system-prompt"]).toContain("#9 on Project-level.");
    expect(payload(buildReviewCommentMessage(project)).data).toMatchObject({ commentType: "project", filePath: "", agent: "", status: "outdated" });
  });

  it("puts a batch in one message, one tag per comment, in order", () => {
    const text = buildReviewCommentsMessage([inline, project]);
    const tags = text.split("\n");
    expect(tags).toHaveLength(2);
    expect(tags[0]).toBe(buildReviewCommentMessage(inline));
    expect(tags[1]).toBe(buildReviewCommentMessage(project));
  });

  it("tells a batch from a single comment", () => {
    expect(isReviewCommentBatch({ comments: [inline] })).toBe(true);
    expect(isReviewCommentBatch(inline)).toBe(false);
    expect(isReviewCommentBatch(null)).toBe(false);
  });
});

describe("design comments", () => {
  it("names the page and the element, and asks for a look and a reply", () => {
    const prompt = payload(buildReviewCommentMessage({
      id: 7,
      comment_type: "file",
      file_path: "design/insight/overview.html",
      content: "Make this the primary action",
      design: { name: "insight", page: "overview.html", selector: "main > button.export", text: "Export", replies: ["Ada: agreed"] },
    }))["system-prompt"] as string;
    expect(prompt).toContain("Comment #7 on the design page design/insight/overview.html");
    expect(prompt).toContain('`main > button.export` ("Export")');
    expect(prompt).toContain('Replies so far: "Ada: agreed".');
    expect(prompt).toContain("grove_design_read");
    expect(prompt).toContain("grove_reply_review");
    expect(prompt).not.toContain("Code Review");
  });

  it("says which part of a file a preview comment is on, with its thread", () => {
    const prompt = payload(buildReviewCommentMessage({
      id: 12,
      comment_type: "file",
      file_path: "output/report.md",
      content: "Too long",
      anchor: { selector: "p:nth-of-type(2)", text: "Bravo paragraph here." },
      replies: [{ agent: "Ada", content: "agreed" }],
    }))["system-prompt"] as string;
    expect(prompt).toBe('Please address Comment #12 on the file output/report.md, on the part that reads "Bravo paragraph here.". Comment: "Too long". Replies so far: "Ada: agreed". Use the grove_reply_review tool to reply and set resolve: true when addressed.');
    const selection = payload(buildReviewCommentMessage({ id: 13, comment_type: "file", file_path: "output/report.md", content: "x", anchor: { text: "Bravo paragraph here.", textRange: { quote: "paragraph" } } }))["system-prompt"] as string;
    expect(selection).toContain('reads "paragraph"');
  });
});
