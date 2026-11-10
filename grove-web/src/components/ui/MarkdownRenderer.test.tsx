import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownRenderer file resources", () => {
  it("routes a relative iframe src through the worktree raw endpoint", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownRenderer
        content={'<iframe src="../../internal/diagram.html" title="diagram"></iframe>'}
        location={{
          projectId: "project",
          root: { kind: "task", taskId: "task" },
          path: "output/deliverables/section.md",
        }}
      />);
    });
    const html = container.innerHTML;
    await act(async () => root.unmount());

    expect(html).toContain(
      'src="/api/v1/projects/project/tasks/task/files/raw?path=internal%2Fdiagram.html"',
    );
  });

  it("routes an iframe outside the git root through the unrestricted raw endpoint", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownRenderer
        content={'<iframe src="../../internal/diagram.html"></iframe>'}
        location={{
          projectId: "project",
          root: { kind: "task", taskId: "_local" },
          path: "section.md",
        }}
      />);
    });
    const html = container.innerHTML;
    await act(async () => root.unmount());

    expect(html).toContain(
      'src="/api/v1/projects/project/tasks/_local/files/raw?path=..%2F..%2Finternal%2Fdiagram.html"',
    );
  });

  it("strips an authored allow-same-origin from a worktree iframe", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownRenderer
        content={'<iframe src="evil.html" sandbox="allow-scripts allow-same-origin"></iframe>'}
        location={{ projectId: "project", root: { kind: "task", taskId: "task" }, path: "notes.md" }}
      />);
    });
    const iframe = container.querySelector("iframe");
    await act(async () => root.unmount());

    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
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

describe("MarkdownRenderer code blocks", () => {
  it("copies code on an HTTP-style context without the Clipboard API", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const previousExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    let copiedText = "";
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((command: string) => {
        expect(command).toBe("copy");
        copiedText = (document.activeElement as HTMLTextAreaElement).value;
        return true;
      }),
    });
    try {
      await act(async () => {
        root.render(<MarkdownRenderer content={'```sql\nSELECT 1;\n```'} />);
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[title="Copy code"]')?.click();
      });
      expect(copiedText).toBe("SELECT 1;");
      expect(container.querySelector('button[title="Copied"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (previousExecCommand) Object.defineProperty(document, "execCommand", previousExecCommand);
      else Reflect.deleteProperty(document, "execCommand");
    }
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

describe("MarkdownRenderer lists", () => {
  it("keeps loose-list markers on the same line as the first paragraph", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={'- **Workflow：**需求分析\n\n- **Skill 与工具：**分享 CLI'}
      />,
    );

    expect(html).toContain("[li&gt;&amp;:first-child]:inline");
    expect(html).toContain("<li");
    expect(html).toContain("<p");
  });

  it("preserves ordered-list numbers across intervening content", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={'5. First topic\n\nSupporting detail.\n\n```text\nexample\n```\n\n6. Second topic'}
      />,
    );

    expect(html).toContain('<ol start="5"');
    expect(html).toContain('<ol start="6"');
  });
});

describe("MarkdownRenderer heading links", () => {
  it("keeps fragment links inside the current markdown preview", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(
      <MarkdownRenderer
        content={'[皇帝 喜多川祐介](#皇帝-喜多川祐介)\n\n## 皇帝 喜多川祐介'}
        enableHeadingIds
      />,
    ));

    const link = container.querySelector<HTMLAnchorElement>("a");
    const heading = container.querySelector<HTMLElement>('#皇帝-喜多川祐介');
    expect(decodeURIComponent(link?.getAttribute("href") ?? "")).toBe("#皇帝-喜多川祐介");
    expect(link?.getAttribute("target")).toBeNull();
    expect(heading).not.toBeNull();

    const scrollIntoView = vi.fn();
    if (heading) heading.scrollIntoView = scrollIntoView;
    act(() => link?.click());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    act(() => root.unmount());
    container.remove();
  });

  it("delegates fragment navigation when a virtualized owner handles it", () => {
    const onHeadingLinkClick = vi.fn(() => true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(
      <MarkdownRenderer
        content={'[喜多川祐介](#喜多川祐介)'}
        onHeadingLinkClick={onHeadingLinkClick}
      />,
    ));

    act(() => container.querySelector<HTMLAnchorElement>("a")?.click());
    expect(onHeadingLinkClick).toHaveBeenCalledWith("喜多川祐介");

    act(() => root.unmount());
    container.remove();
  });
});

describe("MarkdownRenderer streaming reconciliation", () => {
  it("preserves completed rich nodes when later text is appended", () => {
    const stableContent = [
      "![diagram](https://example.com/diagram.png)",
      "",
      "```ts",
      "const stable = true;",
      "```",
    ].join("\n");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<MarkdownRenderer content={stableContent} />));
    const image = container.querySelector("img");
    const codeBlock = container.querySelector(".markdown-code-block");

    expect(image).not.toBeNull();
    expect(codeBlock).not.toBeNull();

    act(() =>
      root.render(
        <MarkdownRenderer
          content={`${stableContent}\n\nThe response keeps streaming after the rich blocks.`}
        />,
      ),
    );

    expect(container.querySelector("img")).toBe(image);
    expect(container.querySelector(".markdown-code-block")).toBe(codeBlock);

    act(() => root.unmount());
    container.remove();
  });
});

describe("MarkdownRenderer design references", () => {
  const render = (content: string, studio = true) => renderToStaticMarkup(
    <MarkdownRenderer content={content} sketchContext={studio ? { projectId: "project", taskId: "task" } : undefined} />,
  );

  it("turns design:// references into chips in a Studio task", () => {
    const html = render("Here is the flow: design://checkout-flow and the receipt design://checkout-flow/receipt.html.");
    expect(html).toContain("Open checkout-flow in the Design panel");
    expect(html).toContain("Open checkout-flow · receipt in the Design panel");
    // The sentence's full stop stays text.
    expect(html).toMatch(/<\/button>\.<\/p>/);
  });

  it("names the design system, also when the agent wrapped it in backticks", () => {
    expect(render("See `design://system`")).toContain("Open Design system in the Design panel");
  });

  it("leaves the text alone outside Studio and inside code blocks", () => {
    expect(render("design://checkout-flow", false)).not.toContain("Design panel");
    expect(render("```\ndesign://checkout-flow\n```")).not.toContain("Design panel");
  });

  it("still renders sketch references as chips", () => {
    expect(render("sketch://sketch-550e8400-e29b-41d4-a716-446655440000")).toContain("<button");
  });
});
