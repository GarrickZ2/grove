import { useCallback, useEffect, useMemo, useState } from "react";
import { LineSquiggle } from "lucide-react";
import type { SharedSketches, SketchComment, SketchMeta } from "../../../api";
import { PanelEmpty, PanelError, PanelLoading } from "../../../orbit/ui";
import { SketchBoard } from "./SketchBoard";
import { writtenByReader, type ThreadChanges } from "../DesignPage/threadChanges";

/**
 * Sketches someone shared, read through their share link: the same board as
 * the owner's, read-only, with comments where the link allows them.
 */
export function SharedSketchPage({ source }: { source: SharedSketches }) {
  const [sketches, setSketches] = useState<SketchMeta[] | null>(null);
  const [comments, setComments] = useState<SketchComment[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // `read`: which Refresh it was read for; the canvas starts over on each.
  const [scene, setScene] = useState<{ id: string; scene: unknown; read: number } | null>(null);
  // Bumped by Refresh: the sketch shown is read again and the canvas starts over.
  const [sceneTick, setSceneTick] = useState(0);

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
  // Read again whenever the owner's Grove says the comments changed.
  useEffect(() => source.watchComments?.(() => void reload()), [source, reload]);
  // What the reader wrote, they may change.
  const changes = useMemo<ThreadChanges<SketchComment> | undefined>(() => {
    const { editComment, deleteComment } = source;
    if (!editComment || !deleteComment) return undefined;
    return {
      canChange: writtenByReader,
      edit: async (comment, text, replyId) => {
        await editComment(comment.id, text, replyId);
        await reload();
      },
      remove: async (comment, replyId) => {
        await deleteComment(comment.id, replyId);
        await reload();
      },
    };
  }, [source, reload]);

  const shown = activeId && sketches?.some((sketch) => sketch.id === activeId) ? activeId : sketches?.[0]?.id ?? null;
  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    source.scene(shown)
      .then((value) => { if (!cancelled) setScene({ id: shown, scene: value, read: sceneTick }); })
      .catch(() => { if (!cancelled) setScene({ id: shown, scene: null, read: sceneTick }); });
    return () => { cancelled = true; };
  }, [source, shown, sceneTick]);

  if (failure && !sketches) return <PanelError title="Couldn't load the sketches" onRetry={() => void reload()}>{failure}</PanelError>;
  if (!sketches) return <PanelLoading />;

  const { addComment, reply } = source;
  return (
    <SketchBoard
      sketches={sketches}
      activeId={shown}
      onSelect={setActiveId}
      scene={scene?.scene ?? null}
      sceneKey={`${shown ?? ""}-${scene?.read ?? 0}`}
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
      changes={changes}
      onRefresh={async () => {
        setSceneTick((tick) => tick + 1);
        await reload();
      }}
      agent={null}
      canSend={false}
      empty={<PanelEmpty icon={LineSquiggle} title="No sketches" />}
    />
  );
}
