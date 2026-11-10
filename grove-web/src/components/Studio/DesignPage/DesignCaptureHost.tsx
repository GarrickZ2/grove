import { useEffect, useRef, useState } from "react";
import { uploadDesignCapture, designFilesBase, type Design, type DesignPage, type DesignReport } from "../../../api/designs";
import { DesignFrame, type DesignFrameHandle } from "./DesignFrame";
import { pageHeight } from "./designModel";
import { loadPageHtml } from "./useDesignData";

interface Job {
  design: string;
  page: DesignPage;
  html: string;
}

interface Props {
  projectId: string;
  taskId: string;
  token: string;
  designs: Design[];
  /** A page was rendered: its version and how tall it came out. */
  onCaptured: (design: string, file: string, version: string, height: number) => void;
}

/** After the page reports ready, late content gets this long to land. */
const SETTLE_MS = 400;
const LOAD_TIMEOUT_MS = 20_000;

/**
 * Renders pages out of sight so the agent can look at them. Whenever a page's
 * stored render is older than the page, this draws it in a hidden frame and
 * uploads the image and the page check; `design_read` hands them to the agent.
 * One page at a time, any design of the task, whether or not it is on screen.
 */
export function DesignCaptureHost({ projectId, taskId, token, designs, onCaptured }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [height, setHeight] = useState(0);
  const frame = useRef<DesignFrameHandle>(null);
  // Versions already tried in this window: a page that cannot be drawn is not retried forever.
  const tried = useRef(new Set<string>());
  const finished = useRef<(height: number) => void>(() => {});

  useEffect(() => {
    if (job) return;
    const next = designs
      .flatMap((design) => design.pages.map((page) => ({ design: design.slug, page })))
      .find(({ design, page }) => page.capture_version !== page.version && !tried.current.has(`${design}/${page.file}@${page.version}`));
    if (!next) return;
    let cancelled = false;
    loadPageHtml(projectId, taskId, next.design, next.page.file, next.page.version)
      .then((html) => {
        if (cancelled) return;
        tried.current.add(`${next.design}/${next.page.file}@${next.page.version}`);
        setHeight(next.page.height);
        setJob({ design: next.design, page: next.page, html });
      })
      .catch(() => {
        // The file went away; the next poll drops the page.
        tried.current.add(`${next.design}/${next.page.file}@${next.page.version}`);
      });
    return () => { cancelled = true; };
  }, [job, designs, projectId, taskId]);

  useEffect(() => {
    if (!job) return;
    const { design, page } = job;
    let done = false;
    const finish = async (report: DesignReport | null, failure?: string) => {
      if (done) return;
      done = true;
      let image: string | undefined;
      let checked = report ?? { height: pageHeight(page), issues: [] };
      if (report) {
        try {
          const capture = await frame.current?.capture();
          if (capture) {
            image = capture.image;
            checked = capture.report;
            if (capture.error) failure = `The page could not be drawn as an image (${capture.error})`;
            else if (checked.height > 6000) failure = `The image shows the first 6000px of a ${checked.height}px page`;
          }
        } catch (cause) {
          failure = `The page could not be drawn as an image (${(cause as Error).message})`;
        }
      }
      if (failure) checked = { ...checked, issues: [...checked.issues, { message: failure }] };
      try {
        await uploadDesignCapture(projectId, taskId, design, page.file, { version: page.version, image, report: checked });
        onCaptured(design, page.file, page.version, checked.height);
      } catch {
        // Not stored; the page stays unrendered for the agent until it changes or the panel reopens.
      }
      setJob(null);
    };
    let settle: number | undefined;
    finished.current = (reported) => {
      // Grow to the content once, as the board does, then let it settle.
      setHeight((current) => Math.max(current, reported));
      window.clearTimeout(settle);
      settle = window.setTimeout(() => void finish({ height: reported, issues: [] }), SETTLE_MS);
    };
    const timeout = window.setTimeout(() => void finish(null, "The page did not finish loading"), LOAD_TIMEOUT_MS);
    return () => {
      done = true;
      window.clearTimeout(settle);
      window.clearTimeout(timeout);
    };
  }, [job, projectId, taskId, onCaptured]);

  if (!job) return null;
  return (
    <div className="design-capture-host" aria-hidden="true">
      <DesignFrame
        ref={frame}
        key={`${job.design}/${job.page.file}@${job.page.version}`}
        html={job.html}
        version={job.page.version}
        filesBase={designFilesBase(token, projectId, taskId, job.design)}
        title=""
        width={job.page.width}
        height={height}
        interactive={false}
        onReady={(report) => finished.current(report.height)}
      />
    </div>
  );
}
