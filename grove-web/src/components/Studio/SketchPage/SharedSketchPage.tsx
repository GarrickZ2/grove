import { useCallback, useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import type { SharedSketches, SketchComment, SketchMeta } from "../../../api";
import { PanelEmpty, PanelError, PanelLoading } from "../../../orbit/ui";
import { SketchBoard } from "./SketchBoard";

/**
 * Sketches someone shared, read through their share link: the same board as
 * the owner's, read-only, with comments where the link allows them.
 */
export function SharedSketchPage({ source }: { source: SharedSketches }) {
  const [sketches, setSketches] = useState<SketchMeta[] | null>(null);
  const [comments, setComments] = useState<SketchComment[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scene, setScene] = useState<{ id: string; scene: unknown } | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await source.list();
      setSketches(data.sketches);
      setComments(data.comments);
      setFailure(null);
    } catch (error) {
      setFailure((error as { message?: string })?.message ?? "Couldn't load the sketches");
    }
  }, [source]);
  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [reload]);

  const shown = activeId && sketches?.some((sketch) => sketch.id === activeId) ? activeId : sketches?.[0]?.id ?? null;
  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    source.scene(shown)
      .then((value) => { if (!cancelled) setScene({ id: shown, scene: value }); })
      .catch(() => { if (!cancelled) setScene({ id: shown, scene: null }); });
    return () => { cancelled = true; };
  }, [source, shown]);

  if (failure && !sketches) return <PanelError title="Couldn't load the sketches" onRetry={() => void reload()}>{failure}</PanelError>;
  if (!sketches) return <PanelLoading />;

  const { addComment, reply } = source;
  return (
    <SketchBoard
      sketches={sketches}
      activeId={shown}
      onSelect={setActiveId}
      scene={scene?.scene ?? null}
      sceneKey={shown ?? ""}
      sceneLoading={!scene || scene.id !== shown}
      comments={comments}
      onAddComment={addComment ? async (sketch, anchor, content) => {
        await addComment({ sketch, anchor, content });
        await reload();
      } : undefined}
      onReply={reply ? async (id, content) => {
        await reply(id, content);
        await reload();
      } : undefined}
      agent={null}
      canSend={false}
      empty={<PanelEmpty icon={Pencil} title="No sketches" />}
    />
  );
}
