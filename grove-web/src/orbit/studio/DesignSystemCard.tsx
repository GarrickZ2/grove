import { useState } from "react";
import { Maximize2, Shapes } from "lucide-react";
import { designSystemKey } from "../../api/designs";
import { DesignPage } from "../../components/Studio/DesignPage";
import { Button, Card, EmptyState, Sheet } from "../ui";

const VIEW_ONLY = { canComment: false };

/** The Project's design system: whether there is one, and its board to look at. */
export function DesignSystemCard({ projectId }: { projectId: string }) {
  const [has, setHas] = useState(false);
  const [open, setOpen] = useState(false);
  const key = designSystemKey(projectId);
  const empty = (
    <EmptyState icon={Shapes} title="No design system yet">
      It shows up here once an agent makes one in a task.
    </EmptyState>
  );

  return (
    <>
      <Card
        className="osd-system"
        aria-label="Design system"
        title="Design system"
        actions={has ? <Button variant="ghost" size="sm" onClick={() => setOpen(true)}><Maximize2 />Open</Button> : null}
      >
        <div className="osd-system-body">
          <DesignPage projectId={key} taskId="system" shared={VIEW_ONLY} bare empty={empty} onHasDesign={setHas} />
        </div>
      </Card>
      <Sheet open={open && has} onClose={() => setOpen(false)} label="Design system" title="Design system" wide>
        <div className="oui-sheet-body osd-system-sheet">
          <DesignPage projectId={key} taskId="system" shared={VIEW_ONLY} bare empty={empty} />
        </div>
      </Sheet>
    </>
  );
}
