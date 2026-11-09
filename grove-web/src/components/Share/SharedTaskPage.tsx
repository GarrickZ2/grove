import { useCallback, useMemo } from "react";
import { markReceivedShareSeen, receivedShareSource } from "../../api/shares";
import { SharedTaskView } from "./SharedTaskView";
import { sharedListChanged } from "./shareEvents";

/** A Task someone shared with this Grove, read through this Grove's server. */
export function SharedTaskPage({ id }: { id: string }) {
  const source = useMemo(() => receivedShareSource(id), [id]);
  const onInfo = useCallback(() => {
    void markReceivedShareSeen(id).then(sharedListChanged).catch(() => {});
  }, [id]);
  return (
    <div className="orbit-ui" style={{ height: "100%" }}>
      <SharedTaskView
        key={id}
        source={source}
        viewerCanComment
        showComments
        onInfo={onInfo}
      />
    </div>
  );
}
