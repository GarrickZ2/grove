import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";

describe("MarkdownRenderer file resources", () => {
  it("routes a relative iframe src through the worktree raw endpoint", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={'<iframe src="../../internal/diagram.html" title="diagram"></iframe>'}
        location={{
          projectId: "project",
          root: { kind: "task", taskId: "task" },
          path: "output/deliverables/section.md",
        }}
      />,
    );

    expect(html).toContain(
      'src="/api/v1/projects/project/tasks/task/files/raw?path=internal%2Fdiagram.html"',
    );
  });

  it("routes an iframe outside the git root through the unrestricted raw endpoint", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={'<iframe src="../../internal/diagram.html"></iframe>'}
        location={{
          projectId: "project",
          root: { kind: "task", taskId: "_local" },
          path: "section.md",
        }}
      />,
    );

    expect(html).toContain(
      'src="/api/v1/projects/project/tasks/_local/files/raw?path=..%2F..%2Finternal%2Fdiagram.html"',
    );
  });

  it("renders an error instead of the Grove page for an empty iframe src", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer content={'<iframe src=""></iframe>'} />,
    );

    expect(html).toContain("Embedded resource unavailable");
    expect(html).not.toContain("<iframe");
  });

  it("renders an error for a relative iframe without a file location", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer content={'<iframe src="diagram.html"></iframe>'} />,
    );

    expect(html).toContain("Embedded resource unavailable");
    expect(html).not.toContain("<iframe");
  });
});

describe("MarkdownRenderer emphasis", () => {
  it("renders CJK labels ending in a full-width colon as strong text", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer content={'- **商家上下文分散：**集成方案'} />,
    );

    expect(html).toContain("<strong");
    expect(html).toContain("商家上下文分散：</strong>集成方案");
    expect(html).not.toContain("**商家上下文分散");
  });
});
